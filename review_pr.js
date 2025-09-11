import core from "@actions/core";
import github from "@actions/github";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs/promises";

const {
  GITHUB_TOKEN,
  OPENAI_API_KEY,
  MODEL = "gpt-4o-mini",
  MAX_TOKENS = "20000",
  TIME_BUDGET_SECONDS = "120",
  MAX_FILES = "30",
  MAX_LINES = "1200",
  LINE_TRIM_PER_FILE = "300",
  RISKY_EXTS = "js,ts,tsx,jsx,py,go,rb,php,java,kt,cs,rs,swift,c,cc,cpp,h,sql,sh,ps1,yml,yaml,json,html,htm,css,scss,vue,mdx,tf,tfvars,hcl",
  OPENAI_BASE_URL = "https://api.openai.com/v1",
  OPENAI_ORG = ""
} = process.env;

const riskySet = new Set(RISKY_EXTS.split(",").map(s => s.trim().toLowerCase()));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const started = Date.now();
const deadline = started + Number(TIME_BUDGET_SECONDS) * 1000;

const abortIfTimeUp = () => { if (Date.now() > deadline) throw new Error("TIME_BUDGET_EXCEEDED"); };

const octokit = github.getOctokit(GITHUB_TOKEN);
const { context } = github;
const owner = context.repo.owner;
const repo = context.repo.repo;
const COMMENT_TAG = "<!-- secure-code-review-bot -->";

async function getPRNumber() {
  const n = context.payload.pull_request?.number;
  if (!n) throw new Error("This action must run on pull_request events.");
  return n;
}

function isBinaryOrLarge(f) { return f.status === "removed" || f.patch == null; }
function hasRiskyExt(filename) { const ext = filename.toLowerCase().split(".").pop(); return riskySet.has(ext); }
function trimPatchLines(patch, limit) {
  const lines = patch.split("\n");
  if (lines.length <= limit) return patch;
  const header = lines[0].startsWith("@@") ? lines[0] : "";
  return [header, ...lines.slice(0, limit)].join("\n");
}

async function listChangedFiles(prNumber, capFiles, capLines, perFileCap) {
  let page = 1, per_page = 100, files = [], totalLines = 0;
  for (;;) {
    abortIfTimeUp();
    const { data } = await octokit.rest.pulls.listFiles({ owner, repo, pull_number: prNumber, per_page, page });
    if (data.length === 0) break;
    for (const f of data) {
      if (files.length >= capFiles) break;
      if (isBinaryOrLarge(f) || !hasRiskyExt(f.filename)) continue;
      let patch = (f.patch || "")
        .split("\n")
        .filter(l => l.startsWith("@@") || l.startsWith("+") || l.startsWith("-"))
        .join("\n");
      if (!patch.trim()) continue;
      patch = trimPatchLines(patch, perFileCap);
      const patchLines = patch.split("\n").length;
      if (totalLines + patchLines > capLines) {
        const remaining = Math.max(0, capLines - totalLines);
        if (remaining === 0) break;
        patch = trimPatchLines(patch, remaining);
      }
      totalLines += patch.split("\n").length;
      files.push({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch });
      if (files.length >= capFiles || totalLines >= capLines) break;
    }
    if (data.length < per_page || files.length >= capFiles || totalLines >= capLines) break;
    page++;
  }
  return { files, totalLines };
}

async function loadPrompt() {
  const promptPath = path.join(__dirname, "prompt.txt");
  return fs.readFile(promptPath, "utf8");
}

function buildUserMessage(files) {
  let body = "Unified diffs (changed hunks only). Each block begins with '=== FILE ==='.\n";
  for (const f of files) {
    body += `\n=== FILE: ${f.filename} (${f.status}, +${f.additions}/-${f.deletions}) ===\n`;
    body += f.patch + "\n";
  }
  return body;
}

async function callOpenAI(systemPrompt, userContent) {
  abortIfTimeUp();
  const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      ...(OPENAI_ORG ? { "OpenAI-Organization": OPENAI_ORG } : {})
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: Number(MAX_TOKENS),
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
      ]
    })
  });
  if (resp.status === 429) throw new Error("OPENAI_INSUFFICIENT_QUOTA");
  if (!resp.ok) throw new Error(`OpenAI HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

async function upsertPRComment(prNumber, content) {
  abortIfTimeUp();
  const header = `## 🔐 Secure Code Review (AI)\n${COMMENT_TAG}`;
  const body = `${header}\n\n${content}\n\n---\n_Models can make mistakes. Verify before merging._`;
  const { data: comments } = await octokit.rest.issues.listComments({ owner, repo, issue_number: prNumber, per_page: 100 });
  const mine = comments.find(c => c.body?.includes(COMMENT_TAG));
  if (mine) await octokit.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body });
  else await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
}

async function run() {
  try {
    const prNumber = await getPRNumber();
    const { files, totalLines } = await listChangedFiles(prNumber, Number(MAX_FILES), Number(MAX_LINES), Number(LINE_TRIM_PER_FILE));
    if (files.length === 0) { await upsertPRComment(prNumber, "No eligible code changes."); return; }
    const systemPrompt = await loadPrompt();
    const userMessage = buildUserMessage(files);
    const analysis = await callOpenAI(systemPrompt, userMessage);
    await upsertPRComment(prNumber, analysis || "No output from model.");
  } catch (err) {
    const prNumber = context.payload.pull_request?.number;
    if (String(err).includes("OPENAI_INSUFFICIENT_QUOTA") && prNumber) {
      await upsertPRComment(prNumber, "⚠️ Could not complete review: **API quota exceeded**. Add billing or use another provider.");
    } else if (prNumber) {
      await upsertPRComment(prNumber, `⚠️ Could not complete review: \`${String(err)}\``);
    }
    core.setFailed(String(err));
  }
}
run();
