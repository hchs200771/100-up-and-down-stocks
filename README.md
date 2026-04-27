<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/5dd3b4df-4788-40bb-9fb0-054b9a54b4e1

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

---

## 盤後報告自動化（Claude Code Skill）

這個專案另外提供一個 Claude Code Skill `daily-stock-report`，取代原本的 Gemini API 流程，改由 Claude 本地分析、再透過 Google Apps Script webhook 寄信。

### 環境變數（`.env.local`）

```
GAS_WEBHOOK_URL=https://script.google.com/macros/s/.../exec
```

### 手動執行

**跑完整流程**（抓資料 → Claude 分析 → 寄信）：在 Claude Code 裡輸入：

```
/daily-stock-report
```

**只重抓市場資料**（不做分析）：

```bash
npx tsx scripts/fetch-market-data.ts
```
會寫入 `data/market-latest.json`。當日（Asia/Taipei）跑過後，Skill 會自動用這份快取，跳過重抓。

**只重寄信**（用現有的 `data/analysis-latest.json` 產 HTML + POST 到 GAS）：

```bash
npx tsx scripts/send-report.ts
```

**只產 HTML 預覽、不寄信**：

```bash
npx tsx scripts/send-report.ts data/analysis-latest.json --no-email
```
輸出在 `data/report-latest.html`。

**只重做 Claude 分析、不重抓 API**：在 Claude Code 裡叫 `/daily-stock-report`，只要 `data/market-latest.json` 的 mtime 還在今天，Skill 會自動用快取，只重跑分類/故事/總結。這條路徑適合迭代 prompt 或重寫 Skill 內容時驗證效果。

### 排程執行（launchd，週一到週五 18:00 自動觸發）

首次安裝：

```bash
cp scripts/launchd/com.maxhuang.daily-stock-report.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.maxhuang.daily-stock-report.plist
```

停用 / 移除：

```bash
launchctl unload ~/Library/LaunchAgents/com.maxhuang.daily-stock-report.plist
rm ~/Library/LaunchAgents/com.maxhuang.daily-stock-report.plist
```

若 Mac 在 18:00 當下是關機或睡眠狀態，launchd 會在下次喚醒時自動補跑一次。wrapper 腳本會等網路恢復最多 15 分鐘，若仍失敗會跳 macOS 通知。

### 檔案位置

- Skill 定義：`.claude/skills/daily-stock-report/SKILL.md`
- 排程 plist：`scripts/launchd/com.maxhuang.daily-stock-report.plist`
- launchd wrapper：`scripts/run-daily-report.sh`
- 市場資料（每日覆蓋）：`data/market-latest.json`
- 分析結果（每日覆蓋）：`data/analysis-latest.json`
- HTML 預覽：`data/report-latest.html`
- 歷史記憶（波段趨勢比對用）：`data/memory/YYYY-MM-DD.md`
- 執行 log：`data/logs/`
