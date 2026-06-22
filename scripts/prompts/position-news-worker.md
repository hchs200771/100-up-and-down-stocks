請針對「我手上的單一期貨持倉標的」做今日新聞 research，沿用既有族群 worker 的 web search 流程。

輸入：本 prompt 結尾會附上單一持倉的 JSON（來自 data/position-analysis.json 的一個 position 物件），含 `underlyingName`、`underlyingCode`、`type`、`side`、`lots`、`queryHints`、`underlyingMarket`。

任務：
1. 用 web search 查該標的（個股期貨用 `underlyingName`/`underlyingCode`；微臺/指數期貨查當日台股大盤）最近 1–2 天的新聞。
2. 找出今日最關鍵的催化或風險：營收/法說、報價、訂單、法人動向、產業題材、個股事件。
3. 結合 `underlyingMarket`（今日漲跌、外本比、當沖比）與我的部位方向 `side`，講清楚這個消息對「我這個方向」是順風還是逆風。

輸出固定 JSON，寫到指定路徑：
```json
{
  "underlyingCode": "2408",
  "underlyingName": "南亞科",
  "headline": "一句話今日重點",
  "news": "120 字內：今日最關鍵催化/風險，繁體中文、資深分析師口吻，不要列來源",
  "positionImpact": "順風 | 逆風 | 中性",
  "impactReason": "結合我的部位方向與今日盤面，說明為什麼"
}
```

限制：
- 只看最近 1–2 天，不要把來源清單或長摘要帶進輸出。
- 找不到明確新聞時，用該標的的產業題材與今日盤面（漲跌、籌碼）補成有解釋力的判讀，不要只寫「沒有新聞」。
- 不要重複畫面已知的事（例如「今天漲 10%」），要講為什麼漲、消息是什麼、對我的部位影響。
- `positionImpact` 必須是 `順風`/`逆風`/`中性` 三者之一。
