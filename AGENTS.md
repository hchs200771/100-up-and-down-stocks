# Agent Instructions

These instructions apply to this repository unless a more specific instruction file overrides them.

## Project Context

This project is a React/TypeScript app with a Node/TypeScript report automation flow for Taiwan stock market daily reports.

Primary entry points:

- App/dev server: `npm run dev`
- Type check: `npm run lint`
- Build: `npm run build`
- Daily after-market report workflow: `npm run report`

## Task Quick Reference

Use this section first when deciding what to do. Do not start by reading the full README unless the task is unclear after this page.

### Daily After-Market Report

When the user asks to run the daily report, produce today's after-market report, or send the report, run exactly one command:

```bash
npm run report
```

Do not split the daily report task into alternate commands unless the user explicitly asks to debug a failed run.

After completion, report the trading date and whether the report was sent.

#### Choosing the runtime

- **Codex CLI** (default): `npm run report` or `npm run report:codex`
- **Claude Code CLI**: `npm run report:claude`

Both run the same 5-stage pipeline (fetch → classify → research → finalize → send). The only difference is which AI CLI drives the controller, workers, and finalizer prompts.

Skill to use: none by default. Use `.claude/skills/daily-stock-report/SKILL.md` only when the user explicitly wants the manual Claude skill path.

### "改分類", "改 worker 搜尋", "改 finalizer", "改盤後報告 prompt"

Use skill: `.claude/skills/stock-report-maintenance/SKILL.md`.

Start with these files:

- `scripts/prompts/group-task-controller.md`: category/task creation
- `scripts/prompts/group-research-worker.md`: per-category research story
- `scripts/prompts/group-finalizer.md`: final analysis assembly and summary
- `scripts/refine-group-tasks.ts`: deterministic category corrections
- `scripts/run-daily-report-codex-parallel.sh`: workflow orchestration

For validation, use the actual daily report path: `npm run report`.

### "改排程", "launchd", "每天自動跑"

Start with:

- `scripts/launchd/com.maxhuang.daily-stock-report-codex.plist`
- `scripts/run-daily-report-codex-parallel.sh`

Do not edit the user's installed `~/Library/LaunchAgents` copy unless explicitly asked.

### "改資料格式", "analysis-latest schema", "email HTML"

Start with:

- `scripts/send-report.ts`
- `data/analysis-latest.json` only as an example input, not as source code
- `data/report-latest.html` only as generated output

Preserve the `analysis-latest.json` contract unless the user explicitly asks to migrate it.

Important files and directories:

- `src/`: frontend app code
- `server.ts`: local server
- `scripts/`: report automation scripts
- `scripts/prompts/`: Codex controller/worker/finalizer prompts
- `data/market-latest.json`: latest market snapshot
- `data/analysis-latest.json`: latest analysis payload
- `data/report-latest.html`: generated HTML report
- `data/memory/YYYY-MM-DD.md`: historical memory used for trend comparison
- `.claude/skills/daily-stock-report/SKILL.md`: manual daily report skill

## Collaboration Rules

- If the request is clear, proceed without waiting for confirmation.
- Ask only when missing information would materially change the result.
- Ask one question at a time.
- Implement the smallest reasonable change that satisfies the request.
- Avoid broad refactors, new abstractions, or signature changes unless explicitly requested or clearly required.
- Before non-trivial edits, inspect nearby code and match existing conventions.
- Do not touch generated data files under `data/` unless the task is specifically about report output or data generation.
- Preserve user changes in the worktree. Do not revert unrelated edits.

## Prompt And Agent Rules

- Prefer outcome-oriented prompts with clear success criteria over step-by-step process scripts.
- Keep hard business constraints separate from style/personality guidance.
- Give search-heavy agents an explicit retrieval budget and stop condition.
- Stop researching once the available evidence is enough to answer the core question.
- Use low or medium reasoning for routine mechanical work; reserve higher reasoning for ambiguous, high-risk, or cross-cutting tasks.

## Verification

- For code changes, run the narrowest relevant verification first.
- Use `npm run lint` for TypeScript correctness.
- Use `npm run build` when frontend behavior, bundling, or production output could be affected.
- For daily report workflow validation, use `npm run report`.

## Final Response

Summarize:

- What changed
- What was verified
- Any remaining risk or skipped verification
