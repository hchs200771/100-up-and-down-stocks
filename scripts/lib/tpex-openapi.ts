/**
 * 櫃買中心 /www/ 端點掛掉時的備援：改抓 openapi，轉成 /www/ 的 { date, tables:[{ data }] } 形狀，
 * 讓既有的 processTpexData / parseTpexInsti 不用改。
 *
 * 2026-10-04 實測：/www/ 整組回 520，openapi 正常。openapi **只有最新一個交易日**，
 * 所以只能拿來補「今天」，不能補指定的歷史日期——呼叫端要自己比對 date。
 */

const OPENAPI = "https://www.tpex.org.tw/openapi/v1";

/** 民國 1151002 → 20261002 */
function rocToYmd(roc: string): string {
  const s = String(roc ?? "").trim();
  if (!/^\d{7}$/.test(s)) return "";
  return `${Number(s.slice(0, 3)) + 1911}${s.slice(3)}`;
}

async function getJson(path: string): Promise<any[]> {
  const res = await fetch(`${OPENAPI}/${path}`);
  if (!res.ok) throw new Error(`TPEx openapi ${path} HTTP ${res.status}`);
  const j = await res.json();
  if (!Array.isArray(j)) throw new Error(`TPEx openapi ${path} 回應不是陣列`);
  return j;
}

/** dailyQuotes 備援：欄位 0 代號、1 名稱、2 收盤、3 漲跌、4 開、5 高、6 低、7 均價、8 成交股數、9 成交金額。 */
export async function fetchTpexQuotesOpenapi(): Promise<{ date: string; tables: { data: string[][] }[] }> {
  const rows = await getJson("tpex_mainboard_daily_close_quotes");
  const date = rocToYmd(rows[0]?.Date);
  if (!date) throw new Error("TPEx openapi 收盤行情沒有日期");
  const data = rows.map((r) => [
    r.SecuritiesCompanyCode, r.CompanyName, r.Close, String(r.Change ?? "").trim(),
    r.Open, r.High, r.Low, r.Average, r.TradingShares, r.TransactionAmount,
  ].map((v) => String(v ?? "").trim()));
  return { date, tables: [{ data }] };
}

/** insti 備援：只填 parseTpexInsti 會讀的欄位（10 外資合計、13 投信、22 自營商、23 三大法人合計），單位股。 */
export async function fetchTpexInstiOpenapi(): Promise<{ date: string; tables: { data: string[][] }[] }> {
  const rows = await getJson("tpex_3insti_daily_trading");
  const date = rocToYmd(rows[0]?.Date);
  if (!date) throw new Error("TPEx openapi 三大法人沒有日期");
  const data = rows.map((r) => {
    const row = new Array<string>(24).fill("0");
    row[0] = String(r.SecuritiesCompanyCode ?? "").trim();
    row[1] = String(r.CompanyName ?? "").trim();
    row[10] = String(r["ForeignInvestorsInclude MainlandAreaInvestors-Difference"] ?? "0");
    row[13] = String(r["SecuritiesInvestmentTrustCompanies-Difference"] ?? "0");
    row[22] = String(r["Dealers-Difference"] ?? "0");
    row[23] = String(r.TotalDifference ?? "0");
    return row;
  });
  return { date, tables: [{ data }] };
}
