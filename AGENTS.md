# Agent Instructions

Node/TypeScript automation flow for Taiwan stock-market reports.

## Commands

- Type check: `npm run lint`
- Daily report: `npm run report`

## Daily report

- Run only when the user explicitly asks; daily execution is manual-only. Do not enable or restore a scheduler unless the user reverses this preference.
- Before starting `npm run report`, sync the broker watchlist: query the Notion data source `collection://f5774c39-be43-426c-8b02-85657137f35e` (分點追蹤名單) through the interactive Notion connector for rows with 啟用 checked, and rewrite `data/broker-watch-config.json` with them (same item shape as the existing file; `pageId` is the row id, and use `""`/`null` for empty fields). `.env.local` has no `NOTION_TOKEN` by choice, so `scripts/fetch-broker-watch.ts` reads only this cache. Report how many pairs were synced. After the run, write any new 最近觸發日／最近買賣超張數 from `data/broker-watch-latest.json` back to Notion through the connector.
- Run exactly `npm run report`. Use alternate or partial commands only to debug a failed run when requested.
- Monitor the process and report stage starts/completions, warnings or fallbacks, and a brief heartbeat at least every 60 seconds. Do not dump prompts or large JSON payloads.
- Once the trading date is known, run `$notion-holdings-health` through the interactive Notion connector; it may proceed alongside the shell pipeline. Include its checked count and attention items in the final result.
- Write the daily trade and holdings review in two places, not in chat: the full version (with sizes, prices, P&L) as a dated section on the current month's Notion 持股健檢 page, and a public version in `data/trade-review-latest.json` (`date` = trading date; `summary`, `trades[]`, `holdings[]` with `name`/`kind`/`side`/`status`/`note`) before the `send` stage. The site is public: the JSON must never contain quantities, prices, cost, or P&L.
- In Notion holdings, change a position's status or trade details only when the user explicitly mentions that position's change. Unmentioned positions remain held as recorded, but still receive fresh health reviews.
- Report the trading date and whether the report was published to the site. The report is web-only; nothing is emailed.
- The investor-conference subpage (`scripts/fetch-investor-conferences.ts`, started by `scripts/start-investor-conf.sh`) runs detached in the background and is never waited on; whatever it finished by `publish` goes out, the rest is picked up next run (7-day window, `data/investor-conf-history/`). Report its status from the newest `data/logs/investor-conf-*.log` but do not wait for it.

`npm run report:codex` and `npm run report:claude` select a runtime explicitly; both target fetch → classify → research → finalize → send → publish (`send` renders the site HTML; it no longer emails). Use `.claude/skills/daily-stock-report/SKILL.md` only when the user explicitly asks for the manual Claude skill path. For the Codex pipeline, keep the controller on the strongest model (currently `gpt-6.1-sol`), the finalizer on GPT-5.6 Sol, and per-category research on GPT-5.6 Luna unless the user requests another split.

## Task routing

- Classification, worker search, finalizer, or report-prompt changes: use `.claude/skills/stock-report-maintenance/SKILL.md`; start in `scripts/prompts/`, `scripts/refine-group-tasks.ts`, and `scripts/run-daily-report-codex-parallel.sh`. Validate through `npm run report`.
- Scheduling or launchd: current policy is manual-only. Legacy references are `scripts/launchd/com.maxhuang.daily-stock-report-codex.plist` and `scripts/run-daily-report-codex-parallel.sh`. Do not modify or load `~/Library/LaunchAgents` unless explicitly asked.
- Analysis schema or report HTML: start with `scripts/send-report.ts`; treat `data/analysis-latest.json` as example input and `data/report-latest.html` as generated output. Preserve the analysis contract unless migration is requested.

## Repository constraints

- Preserve unrelated worktree changes.
- Do not edit generated files under `data/` unless the task concerns report output or data generation.
- Prefer the smallest change that satisfies the request and match nearby conventions.

## Verification

- Run the narrowest relevant check first.
- TypeScript: `npm run lint`.
- Daily workflow changes: `npm run report`.
