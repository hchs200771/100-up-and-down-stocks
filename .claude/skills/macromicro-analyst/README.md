# MacroMicro 知識庫 — Skill 入口索引

把「財經 M 平方」Podcast 蒸餾成一套可重用的總經/產業分析框架。
遇到新經濟事件時，依研究員的思考骨架產出：**影響鏈 → 每條影響的機率 → 對股市的衝擊程度**。

四份檔案用 `[[ ]]` 互連，共一個全域原則：**新者優先**（新舊方法論衝突時採較新集數，舊版降為演進註記）。

## 檔案樹

```
skill/
├── macromicro-analyst/SKILL.md      ⭐ 主框架（任何事件的通用拆解，先讀這份）
├── macromicro-fed-reading/SKILL.md   Fed/FOMC 專用
├── macromicro-data-reading/SKILL.md  數據/原物料專用
└── researchers.md                    研究員視角索引
```

## 1. macromicro-analyst — 主框架（核心）

任何經濟事件 → 影響鏈 → 機率 → 對股市衝擊。

| 區塊 | 內容 |
|---|---|
| 第 0 步 事件定性 | 消息面 vs 基本面 |
| **三層分析**（EP200 逐字稿驗證） | ① 情境拆解（情境階梯）② 判斷勝率（紅線/歷史類比/痛苦指數）③ 數據確認 |
| 第 2 步 傳導鏈 | 事件 → 中介變數 → 終端資產 |
| 第 3 步 定價判斷（Dylan） | 殺估值 vs 殺基本面/戴維斯雙殺、牛熊指數、基本面指數 |
| 第 4 步 衝擊評分 | 方向 / 強度 / 時間 / 錯殺標的 |
| 第 5 步 追蹤清單 | 後續盯什麼數據 |
| 事件 Playbook | A. 地緣危機　B. 央行利率（含日央詳版） |

## 2. macromicro-fed-reading — Fed/FOMC 專用

觸發：問某次 FOMC、點陣圖、Fed 會不會降息、流動性/縮表。
6 區塊：會前定位 → 聲明稿一字一句比對 → 點陣圖（vs 中性利率/市場）→ SEP（雙重使命）→ 記者會 Q&A → 流動性（ONRRP/TGA/存準金、購債 ≠ QE）。

## 3. macromicro-data-reading — 數據/原物料專用

觸發：問油價、金價、庫存、某數據怎麼看。
通用四問 → 原油 Playbook（先量實體規模、$100 門檻、供給 vs 需求）→ 黃金 Playbook（三股力量、籌碼 vs 基本面、後美元）。

## 4. researchers.md — 用誰的視角切入

7 位主力已逐字稿驗證 ⚙️：

| 研究員 | 領域 | 對應 skill |
|---|---|---|
| Rachel | 總經大局收斂 | 主框架 |
| Ryan | Fed / 利率 / 流動性 | fed-reading |
| Ralice | 美國經濟 / 通膨 | fed / data |
| Jason | 原物料 / 黃金 / 貨幣史 | data-reading |
| Dylan | 市場定價 / 牛熊指數 | 主框架第 3 步 |
| Jat | 半導體 / 台股 | （產業） |
| Vivianna | 全球配置 / 日央 | 主框架 |

待驗證 ～：Danny、AL、JC、Lori（助理研究員，出場少）。

## 資料底盤

```
data/
├── episodes.json        320 集 manifest + show notes + 研究員標記
├── transcripts/*.txt     40 集 YouTube 繁體逐字稿（skill 的依據）
└── subs/                 原始字幕 vtt
collect/                  fetch_feed / fetch_yt_subs / find_episodes / transcribe
```

驗證狀態：四份 skill 的核心都建立在這 40 集**近期**逐字稿上、標出處集數。
更早的舊集 YouTube 無字幕，尚未納入（需 Whisper 補，見專案根目錄 README）。

## 怎麼用

遇到新事件 → 開 `macromicro-analyst` 跑三層分析；若是 Fed/數據事件轉對應專用 skill；
用 `researchers.md` 選視角；用 `collect/find_episodes.py "關鍵字"` 撈相關往期當佐證。

> 使用邊界：本知識庫歸納自公開 Podcast，僅供個人學習研究；不對外散布逐字稿、不構成投資建議。
