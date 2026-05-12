---
name: stock-report-maintenance
description: Maintain or modify the Taiwan stock daily report automation, Codex prompts, group research workers, memory files, or report scripts. Trigger when the user asks to change report automation, prompt behavior, classification rules, research workers, finalizer output, or scheduled report behavior.
---

# Stock Report Maintenance Skill

## Outcome

Modify the daily stock report automation with minimal blast radius while preserving the existing report contract.

## Important Contracts

- `data/market-latest.json` is the market input.
- `data/analysis-latest.json` must keep the shape expected by `scripts/send-report.ts`.
- `data/report-latest.html` is generated output.
- `data/memory/YYYY-MM-DD.md` is historical context for trend comparison.
- Use `tradingDate` from market data for report dates and memory filenames.
- Do not rely on system date when the task is about a market trading day.

## Prompt Rules

- Prefer outcome-oriented prompts with clear success criteria.
- Keep classification business rules explicit and short.
- Give research workers a retrieval budget:
  - one precise search first
  - continue only when missing necessary dates, numbers, or source evidence
  - do not search again just to make prose smoother
- Add a stop condition: once evidence supports the category story or final summary, write the result.

## Success Criteria

- Preserve compatibility with `scripts/send-report.ts`.
- Keep generated files out of manual edits unless the task is to regenerate reports.
- Match existing script and prompt style in `scripts/` and `scripts/prompts/`.
- For actual daily report validation, run the same command the daily workflow uses: `npm run report`.
- Use narrower commands only when the user explicitly asks to debug a failed stage.
- Report any skipped full workflow run clearly.
