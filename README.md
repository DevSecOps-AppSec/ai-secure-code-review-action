# AI Secure Code Review Action

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-AI%20Secure%20Code%20Review-blue?logo=github)](https://github.com/marketplace)

Automated **Application Security code review** on **Pull Request changes only**.  
Runs in under 2 minutes and posts a concise, actionable comment back to the PR.

### Features
- Reviews *only changed hunks* — fast and relevant
- Identifies risks: injection, secrets, auth/z gaps, insecure configs
- Structured output: Risk summary, findings, safeguards checklist
- Works with OpenAI, OpenRouter, or any ChatGPT-compatible endpoint

### Required permissions
- `contents: read` — fetch PR diff
- `pull-requests: write` — update a single comment

### Usage
```yaml
name: Secure Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: DevSecOps-AppSec/ai-secure-code-review-action@v1.0.0
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          model: gpt-4o-mini
          time_budget_seconds: 90
          max_files: 20
          max_lines: 1000
```
