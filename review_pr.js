// review_pr.js
// -----------------------------------------
// Secure Code Review Action with GitLeaks integration
// -----------------------------------------

import core from "@actions/core";
import github from "@actions/github";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

// --------------------------------------------------
// Globals / Config
// --------------------------------------------------
const {
  GITHUB_TOKEN,
  OPENAI_API_KEY,
  MODEL = "gpt-4o-mini",
  MAX_TOKENS = "1200",
  TIME_BUDGET_SECONDS = "100",
  MAX_FILES = "30",
  MAX_LINES = "1200",
  LINE_TRIM_PER_FILE = "300",
  RISKY_EXTS = "js,ts,tsx,jsx,py,go,rb,php,java,kt,cs,rs,swift,c,cc,cpp,h,sql,sh,ps1,yml,yaml,json,html,htm,css,scss,vue,mdx",
  OPENAI_BASE_URL,
  OPENAI_ORG = ""
} = process.env;

const riskySet = new Set(RISKY_EXTS.split(",").map(s => s.trim().toLowerCase()));
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const started = Date.now();
const deadline = started + Number(TIME_BUDGET_SECONDS) * 1000;

const octokit = github.getOctokit(GITHUB_TOKEN);
const { context } = github;
const owner = context.repo.owner;
const repo = context.repo.repo;
const COMMENT_TAG = "<!-- secure-code-review-bot -->";

function abortIfTimeUp() {
  if (Date.now() > deadline) throw new Error("TIME_BUDGET_EXCEEDED");
}

// --------------------------------------------------
// GitLeaks helpers (minimal add-on)
// --------------------------------------------------
function loadGitLeaksFindings() {
  try {
    const p = "gitleaks-report.json";
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(data) ? data : (Array.isArray(data?.findings) ? data.findings : []);
  } catch {
    return [];
  }
}

function summarizeGitLeaks(findings, limit = 10) {
  if (!findings.length) return "";
  const lines = findings.slice(0, limit).map(f => {
    const file = f.File || f.file || f.Path || "unknown";
    const rule = f.RuleID || f.ruleID || f.Rule || "rule";
    const line = f.StartLine || f.startLine || f.Line || "?";
    return `- \`${file}\` line ${line}: **${rule}**`;
  });
  const more = findings.length > limit ? `\n…and ${findings.length - limit} more.` : "";
  return `### 🔑 GitLeaks Findings\n${lines.join("\n")}${more}`;
}

// --------------------------------------------------
// Existing helpers (unchanged except safe tweaks)
// --------------------------------------------------
async function getPRNumber() {
  const n = context.payload.pull_request?.number;
  if (!n) throw new Error("This action must run on pull_request events.");
  return n;
}

function isBinaryOrLarge(f) {
  return f.status === "removed" || f.patch == null;
}
function hasRiskyExt(filename) {
  const ext = filename.toLowerCase().split(".").pop();
  return riskySet.has(ext);
}
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
  return fs.readFileSync(promptPath, "utf8");
}

function buildUserMessage(files) {
  let body = ">>> BEGIN_PATCHES\n";
  for (const f of files) {
    body += `\n=== FILE: ${f.filename} (${f.status}, +${f.additions}/-${f.deletions}) ===\n`;
    body += "```diff\n" + (f.patch || "") + "\n```\n";
  }
  body += "\n<<< END_PATCHES";
  return body;
}

async function callOpenAI(systemPrompt, userContent) {
  abortIfTimeUp();
  const base = (OPENAI_BASE_URL && OPENAI_BASE_URL.trim())
    ? OPENAI_BASE_URL.trim().replace(/\/+$/, "")
    : "https://api.openai.com/v1";
  const resp = await fetch(`${base}/chat/completions`, {
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

// --------------------------------------------------
// Main run()
// --------------------------------------------------
async function run() {
  try {
    const prNumber = await getPRNumber();
    const { files } = await listChangedFiles(prNumber, Number(MAX_FILES), Number(MAX_LINES), Number(LINE_TRIM_PER_FILE));

    if (files.length === 0) {
      await upsertPRComment(prNumber, "No eligible code changes.");
      return;
    }

    const systemPrompt = await loadPrompt();
    let userMessage = buildUserMessage(files);

    const analysis = await callOpenAI(systemPrompt, userMessage);

    // 🔑 GitLeaks integration (minimal touch)
    const gitleaks = loadGitLeaksFindings();
    const extras = summarizeGitLeaks(gitleaks);

    await upsertPRComment(prNumber, [analysis || "No output from model.", extras].filter(Boolean).join("\n\n"));
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
