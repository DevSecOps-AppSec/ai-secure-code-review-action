# AI Secure Code Review Action

A GitHub Action that performs an **automated security code review** on **only the changed hunks in a Pull Request**.  
It runs against OpenAI or compatible APIs and posts findings back as a PR comment. Timeboxed to ~2 minutes.

## Usage

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
      - uses: DevSecOps-AppSec/ai-secure-code-review-action@v1
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          model: gpt-4o-mini
          max_files: "20"
          max_lines: "1000"
          time_budget_seconds: "90"
