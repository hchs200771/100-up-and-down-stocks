/**
 * 個別券商目標價新聞：只用「標題」抽出 股票／券商／目標價。純規則、零 LLM。
 *
 * 為什麼只看標題、不抓全文：經濟日報、MoneyDJ 的 robots.txt 明文禁止 AI／資料探勘用途，
 * Yahoo 擋 AI 爬蟲、工商時報直接 403。Google News RSS 只給標題＋日期＋媒體名，
 * 這裡就只用這些，頁面上一律連回原文。
 *
 * 標題寫法很雜，抽取刻意保守，寧可漏也不要錯：
 *  - 標題裡要剛好認出一檔台股（用全市場名稱表比對，券商名稱先挖掉，避免「元大」「國泰」誤認成股票）
 *  - 有「這檔／這大廠／它」之類代稱的不抽：這種標題的數字常常屬於沒寫名字的另一檔
 *  - 美股、ADR（美元、.US）、FactSet 速報轉載（另外有結構化來源）不收
 * 抽不出目標價、但認得出股票的標題仍保留，頁面上當「相關新聞」列出。
 */

const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`;
const toNum = (s: string) => Number(s.replace(/,/g, ""));

/** 標題裡的寫法 → 顯示名稱。長的先比，「美系外資」不會被「外資」吃掉。 */
const BROKER_ALIASES: Record<string, string> = {
  高盛: "高盛", 大摩: "摩根士丹利", 摩根士丹利: "摩根士丹利", 小摩: "摩根大通", 摩根大通: "摩根大通",
  美銀: "美銀", 花旗: "花旗", 瑞銀: "瑞銀", 大和: "大和", 野村: "野村", 麥格理: "麥格理", 匯豐: "匯豐", 滙豐: "匯豐",
  德意志: "德意志", 巴克萊: "巴克萊", 傑富瑞: "傑富瑞", 里昂: "里昂", 法巴: "法巴", 星展: "星展", Aletheia: "Aletheia",
  美林: "美銀", 摩根大通證券: "摩根大通", 凱基: "凱基", 元大: "元大", 富邦: "富邦", 國泰: "國泰", 永豐: "永豐", 群益: "群益",
  統一投顧: "統一", 兆豐: "兆豐", 華南: "華南", 玉山: "玉山", 第一金: "第一金", 康和: "康和", 宏遠: "宏遠", 合庫: "合庫",
  美系外資: "美系外資", 日系外資: "日系外資", 歐系外資: "歐系外資", 亞系外資: "亞系外資", 港系外資: "港系外資", 陸系外資: "陸系外資",
  本土投顧: "本土投顧", 外資: "外資", 投顧: "投顧", 法人: "法人", 券商: "券商",
};
/** 只寫「外資／投顧／法人」的不算具名，有具名的就不顯示這些 */
const GENERIC = new Set(["外資", "投顧", "法人", "券商"]);
/** 沒指出是哪一家的（含「美系外資」這種只有區域的）。去重時可以併進同一天、同目標價的具名券商 */
export const isUnnamedBroker = (b: string | undefined) => !b || GENERIC.has(b) || b.endsWith("系外資") || b === "本土投顧";
const BROKER_RE = new RegExp(
  Object.keys(BROKER_ALIASES).sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "g",
);

const UP_RE = /上調|調升|調高|上修|提高|升目標|升至|升到|直衝|大升|再升|喊升/;
const DOWN_RE = /下調|調降|下修|砍|降至|降到|下砍|腰斬/;
/** 代稱：數字很可能屬於這個沒寫名字的股票 */
const VAGUE_RE = /這檔|這家|「這|這「|這大廠|這\d|它|另檔|1檔|一檔/;
const SKIP_RE = /factset|美元|\.US|\([A-Z]{1,5}\)|ETF|爆料同學會/i;

export interface TargetCall {
  code: string;
  name: string;
  brokers: string[];
  target: number | null;
  prevTarget: number | null;
  direction: "up" | "down" | null;
}

export type NameIndex = { name: string; code: string }[];

/** 全市場名稱表（長的先比）。兩個字以下的名稱太容易撞到一般用字，不收。 */
export function buildNameIndex(stockMap: Record<string, { name: string }>): NameIndex {
  return Object.entries(stockMap)
    .filter(([code, v]) => /^\d{4}$/.test(code) && v.name && v.name.length >= 2)
    .map(([code, v]) => ({ name: v.name, code }))
    .sort((a, b) => b.name.length - a.name.length);
}

/** 標題 → 抽取結果；不是台股目標價新聞就回 null，認得股票但抽不出數字就 target=null */
export function extractTargetCall(rawTitle: string, names: NameIndex): TargetCall | null {
  const title = rawTitle.replace(/\s+/g, " ").trim();
  if (!title.includes("目標價") || SKIP_RE.test(title)) return null;

  const brokersRaw = [...title.matchAll(BROKER_RE)].map((m) => BROKER_ALIASES[m[0]]);
  // 券商名稱挖掉再比股票，「國泰」「元大」「富邦」不會被當成國泰金、元大金
  const stripped = title.replace(BROKER_RE, "＃");
  const codeInTitle = [...stripped.matchAll(/[（(]\s*(\d{4})\s*[)）]/g)].map((m) => m[1]);
  const hits: { name: string; code: string }[] = [];
  let rest = stripped;
  for (const n of names) {
    if (rest.includes(n.name)) {
      hits.push(n);
      rest = rest.split(n.name).join("＃"); // 「南亞科」比到之後，「南亞」不會再命中
    }
  }
  const codes = new Set([...hits.map((h) => h.code), ...codeInTitle]);
  if (codes.size !== 1) return null;
  const code = [...codes][0];
  const name = hits.find((h) => h.code === code)?.name ?? names.find((n) => n.code === code)?.name;
  if (!name) return null;

  // 「第一金(2892)只剩一家券商看多」：股票本身的名字不是券商
  const own = brokersRaw.filter((b) => !name.startsWith(b));
  const named = [...new Set(own.filter((b) => !GENERIC.has(b)))];
  const brokers = named.length ? named : [...new Set(own)].slice(0, 1);
  const direction = UP_RE.test(title) ? "up" : DOWN_RE.test(title) ? "down" : null;

  if (VAGUE_RE.test(title)) return { code, name, brokers, target: null, prevTarget: null, direction };

  let target: number | null = null;
  let prevTarget: number | null = null;
  const range =
    title.match(new RegExp(`(?:由|從)\\s*${NUM}\\s*元?\\s*(?:上調|調升|調高|上修|提高|升|直衝|調降|下修|下調|降|砍)?\\s*(?:至|到|為)?\\s*${NUM}\\s*(元|萬)`)) ??
    title.match(new RegExp(`${NUM}\\s*元?\\s*(?:→|➝|->)\\s*${NUM}\\s*(元|萬)?`));
  // 「股價從185➝147元」「股價174→286元」是股價，不是目標價
  const isPriceRange = range && /股價\S{0,2}$/.test(title.slice(0, range.index));
  if (range && !isPriceRange) {
    prevTarget = toNum(range[1]);
    target = toNum(range[2]) * (range[3] === "萬" ? 10_000 : 1);
  } else {
    const m =
      title.match(new RegExp(`目標價(?!只差|還差|差距)[^\\d，,。！？!?、|｜]{0,10}?${NUM}\\s*(元|萬)`)) ??
      title.match(new RegExp(`${NUM}\\s*(元|萬)\\s*目標價`));
    if (m) target = toNum(m[1]) * (m[2] === "萬" ? 10_000 : 1);
  }
  // 「目標價喊上萬元」「目標價上看 5 位數」這種沒有數字的，不硬猜
  if (target !== null && !(target > 0)) target = null;
  return { code, name, brokers, target, prevTarget, direction };
}

export interface RssItem {
  title: string;
  source: string;
  url: string;
  publishedAt: string; // ISO
}

const decodeXml = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const tag = (xml: string, name: string) => decodeXml(xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? "").trim();

export function parseGoogleNewsRss(xml: string): RssItem[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const item = m[1];
    const source = tag(item, "source");
    // 標題結尾固定是「 - 媒體名」
    const title = tag(item, "title").replace(new RegExp(`\\s+-\\s+${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "");
    return { title, source, url: tag(item, "link"), publishedAt: new Date(tag(item, "pubDate")).toISOString() };
  });
}

/** Google News 每個查詢最多回 100 則，所以分幾個關鍵字查、再依標題去重 */
export const GOOGLE_QUERIES = ["目標價 外資", "目標價 調升", "目標價 調降", "目標價 投顧", "目標價 買進", "目標價 券商"];

export async function fetchGoogleNews(query: string, whenDays: number): Promise<RssItem[]> {
  const params = new URLSearchParams({ q: `${query} when:${whenDays}d`, hl: "zh-TW", gl: "TW", ceid: "TW:zh-Hant" });
  const res = await fetch(`https://news.google.com/rss/search?${params}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Google News ${query}: HTTP ${res.status}`);
  return parseGoogleNewsRss(await res.text());
}
