# Agent Instructions

Node/TypeScript automation flow for Taiwan stock-market reports.

## Commands

- Type check: `npm run lint`
- Daily report: `npm run report`

## Daily report

- Fetch collects TX 1-minute bars (day + night) into `data/tx-intraday-history/`, backfilling the TAIFEX 30-day window; publish pushes the archive.

- Run only when the user explicitly asks; daily execution is manual-only. Do not enable or restore a scheduler unless the user reverses this preference.
- Before starting `npm run report`, sync the broker watchlist: query the Notion data source `collection://f5774c39-be43-426c-8b02-85657137f35e` (分點追蹤名單) through the interactive Notion connector for rows with 啟用 checked, and rewrite `data/broker-watch-config.json` with them (same item shape as the existing file; `pageId` is the row id, and use `""`/`null` for empty fields). `.env.local` has no `NOTION_TOKEN` by choice, so `scripts/fetch-broker-watch.ts` reads only this cache. Report how many pairs were synced. Read-only: never write trigger results (最近觸發日／最近買賣超張數) back to Notion.
- Before starting `npm run report`, use Chrome with the logged-in user session to open `https://x.com/QQ_Timmy` in a new tab and capture posts back to the last capture, or the past 7 days on the first capture. Transcribe key content from post screenshots into `images`, then write `data/kol/x-inbox/QQ_Timmy.json` as `{handle:"QQ_Timmy",name:"駿哥",capturedAt:<ISO>,posts:[{id,url:<status URL>,postedAt:<ISO>,text,images:<screenshot transcription string, or "">}]}`. Report the capture count. If Chrome or X fails, warn and continue; the KOL bundle will lack 駿哥. 股癌 Telegram needs no manual capture step.
- Run exactly `npm run report`. Use alternate or partial commands only to debug a failed run when requested.
- If a run fails partway, just run `npm run report` again: both runners (Codex and Claude) checkpoint each stage (`data/tmp/report-checkpoint`) and resumes the same trading date from the next unfinished stage (within 6 hours); a finalizer failure that published the skeleton resumes from finalize. Set `CODEX_REPORT_FRESH=1` (or `CLAUDE_REPORT_FRESH=1`) only when a full rerun is really needed.
- Monitor the process and report stage starts/completions, warnings or fallbacks, and a brief heartbeat at least every 60 seconds. Do not dump prompts or large JSON payloads.
- Once the trading date is known, run `$notion-holdings-health` through the interactive Notion connector; it may proceed alongside the shell pipeline. Include its checked count and attention items in the final result.
- Write the daily trade and holdings review in two places, not in chat: the full version (with sizes, prices, P&L) as a dated section on the current month's Notion 持股健檢 page, and a site version in `data/trade-review-latest.json` (`date` = trading date; `summary`, `trades[]`, `holdings[]` with `name`/`kind`/`side`/`status`/`note`, plus `stop` (stop price, or `未設`), `stopStatus` (e.g. `已觸發`, `距 3.5%`, `未設停損`), and `ma20` (distance to the 20-day MA from `data/holdings-tech-latest.json` `ma20Pct`, e.g. `+3.2%`, `−5.8%`; use `—` for holdings without a Taiwan/US daily series) on every holding) before the `send` stage. That file is gitignored and published only as the password-encrypted `review.html` (`scripts/build-private-pages.ts`, `SITE_PASSWORD` in `.env.local`); the stop price is the only price allowed there — keep quantities, other prices, cost, and P&L out of it. In Notion holdings, keep the numeric 停損價 column in sync with 停損／失效條件.
- In Notion holdings, change a position's status or trade details only when the user explicitly mentions that position's change. Unmentioned positions remain held as recorded, but still receive fresh health reviews.
- 公開盤後語音版在 publish 成功後以背景工作啟動，不等待；Claude 寫完 `data/trade-review-latest.json` 後，執行 `npx tsx scripts/build-audio-holdings.ts` 並回報本機音訊絕對路徑。
- Report the trading date and whether the report was published to the site. The report is web-only; nothing is emailed.
- KOL fetch/transcription runs detached with a pid lock; after finalize, snapshot ready items for the brief worker without stopping the fetch, mark only snapshot items seen, and fall back to the latest dated history brief when needed.
- The investor-conference subpage (`scripts/fetch-investor-conferences.ts`, started by `scripts/start-investor-conf.sh`) runs detached in the background and is never waited on; whatever it finished by `publish` goes out, and when it finishes it re-runs `scripts/publish-github-pages.sh` itself so the rest goes out the same day (unfinished sessions are picked up next run; 7-day window, `data/investor-conf-history/`). Report its status from the newest `data/logs/investor-conf-*.log` but do not wait for it.

`npm run report:codex` and `npm run report:claude` select a runtime explicitly; both target fetch → classify → research → finalize → send → publish (`send` renders the site HTML; it no longer emails). Use `.claude/skills/daily-stock-report/SKILL.md` only when the user explicitly asks for the manual Claude skill path. For the Codex pipeline, the controller (classification) and finalizer run on Claude Opus 5.5 via `claude -p` (`claude-opus-5-5`; set `CODEX_CONTROLLER_ENGINE`/`CODEX_FINALIZER_ENGINE=codex` to use `gpt-6.1-sol`), while per-category research and the intl brief stay on `gpt-6-luna` unless the user requests another split. Model names go stale: before a run, compare these defaults against `~/.codex/models_cache.json` and propose upgrading any that a newer generation has replaced.

## Task routing

- Classification, worker search, finalizer, or report-prompt changes: use `.claude/skills/stock-report-maintenance/SKILL.md`; start in `scripts/prompts/`, `scripts/refine-group-tasks.ts`, and `scripts/run-daily-report-codex-parallel.sh`. Validate through `npm run report`.
- Scheduling or launchd: current policy is manual-only. Legacy references are `scripts/launchd/com.maxhuang.daily-stock-report-codex.plist` and `scripts/run-daily-report-codex-parallel.sh`. Do not modify or load `~/Library/LaunchAgents` unless explicitly asked.
- Factor or idea validation (user's new strategy idea): write a research script `scripts/research-<topic>.ts` (reuse the wide-market loader from `scripts/research-new-low-short.ts`), then add an entry at the top of `research/factor-lab/experiments.json` with SVG charts in `research/factor-lab/charts/<id>/`; `scripts/build-factor-lab.ts` renders `factor-lab.html` at publish time. Write every entry for a first-time reader in plain Traditional Chinese: define each group and threshold (e.g. 平開 = 開盤相對昨收 ±0.5% 以內), give every number its unit and say what it is (機率、平均報酬、天數), explain n／區間 in words, and avoid unexplained jargon. Fold a follow-up on the same question into the existing entry instead of adding a near-duplicate.
- Analysis schema or report HTML: start with `scripts/send-report.ts`; treat `data/analysis-latest.json` as example input and `data/report-latest.html` as generated output. Preserve the analysis contract unless migration is requested.

## Repository constraints

- Preserve unrelated worktree changes.
- Do not edit generated files under `data/` unless the task concerns report output or data generation.
- Prefer the smallest change that satisfies the request and match nearby conventions.

## Verification

- Run the narrowest relevant check first.
- TypeScript: `npm run lint`.
- Daily workflow changes: `npm run report`.
