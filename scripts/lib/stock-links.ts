/**
 * 個股 → Yahoo 股市連結。
 *
 * 報告裡個股出現在兩種地方：表格與 chip（產生時就知道代號，直接用 yahooUrl），以及
 * 敘述文字（盤後總結、族群故事、操作建議、KOL…，只有中文名）。後者由 linkifyStocks
 * 在輸出前掃過整份 HTML，把公司名稱換成連結。
 *
 * 名稱對照表取自 data/revenue-history/*.json（月營收快照涵蓋全部上市櫃公司，
 * 含上市／上櫃別），不另外打 API。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type Market = "twse" | "tpex";

/**
 * 不自動連結的名稱：在財經敘述裡常是一般詞彙、地名或外國公司，連上去多半是錯的。
 * 表格與 chip 有代號，不受這張表影響。看到誤連就加進來。
 */
const AMBIGUOUS = new Set([
  "世界", "統一", "大同", "中華", "國產", "全國", "全新", "卓越", "地球", "幸福", "典範", "傳奇", "互動",
  "數字", "光明", "安心", "無敵", "冠軍", "大量", "大樹", "大洋", "大江", "太極", "有益", "創意", "合一",
  "東洋", "華夏", "正道", "正文", "精確", "精華", "樂意", "必應", "綠電", "台南", "南港", "新興", "新建",
  "農林", "時報", "大中", "上品", "立德", "青雲", "春雨", "秋雨", "鳳凰", "京城", "遠見", "進階", "至上",
  "晶華", "中台", "全台", "國建", "宏觀", "光環", "光譜", "全域", "全科", "尖點", "是方", "三星", "惠普",
  "花王", "佳能", "安克", "大塚", "櫻花", "聯合", "華東", "太子", "能率", "及成", "中天", "大成", "全家",
  "日揚", "生合", "直得", "得力", "力新", "高技", "雷虎", "王座", "橙的", "零壹", "雙喜", "首利", "華安",
  "東華", "大華", "中工", "亞航", "東森", "三商", "八貫", "國統", "大亞", "台產", "天良", "長聖", "新產", "加高",
]);

/**
 * 會被一般詞彙「包住」的名稱：前後接這些字時不算（例如「動力成長」裡的「力成」）。
 * key 是公司名，value 是會誤中的完整詞。
 */
const TRAPS: Record<string, string[]> = {
  力成: ["動力成", "壓力成", "實力成", "努力成", "能力成", "魅力成"],
  生達: ["發生達"],
  中電: ["高中電"],
  台化: ["台化纖"],
  上銀: ["線上銀"],
  台通: ["平台通"],
  信義: ["信義區"],
  長榮: ["長榮航"],
};

interface StockRef {
  code: string;
  market: Market;
}

let cache: { byCode: Map<string, StockRef>; byName: Map<string, StockRef> } | null = null;

function load() {
  if (cache) return cache;
  const byCode = new Map<string, StockRef>();
  const byName = new Map<string, StockRef>();
  const dir = resolve(process.cwd(), "data/revenue-history");
  // 舊月份先讀、新月份後讀：改名的公司以最新名稱為準
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort() : [];
  for (const f of files) {
    try {
      const snap = JSON.parse(readFileSync(resolve(dir, f), "utf-8")) as { stocks: Record<string, { n: string; m: Market }> };
      for (const [code, s] of Object.entries(snap.stocks ?? {})) {
        const ref = { code, market: s.m };
        byCode.set(code, ref);
        byName.set(s.n, ref);
        // 敘述裡常省略 -KY／-創 這類後綴（「泰福」而不是「泰福-KY」）
        const bare = s.n.replace(/[-－*＊](KY|創|DR)$/i, "").replace(/\*$/, "");
        if (bare !== s.n && bare.length >= 2 && !byName.has(bare)) byName.set(bare, ref);
      }
    } catch {
      /* 壞檔跳過 */
    }
  }
  cache = { byCode, byName };
  return cache;
}

/** Yahoo 股市個股頁。上櫃用 .TWO；查不到市場別時用 .TW（Yahoo 會自動導到正確頁）。 */
export function yahooUrl(code: string, page = ""): string {
  const ref = load().byCode.get(code);
  const suffix = ref?.market === "tpex" ? ".TWO" : ".TW";
  return `https://tw.stock.yahoo.com/quote/${code}${suffix}${page ? `/${page}` : ""}`;
}

let matcher: RegExp | null = null;
function nameMatcher(): RegExp | null {
  if (matcher) return matcher;
  const names = [...load().byName.keys()].filter((n) => n.length >= 2 && !AMBIGUOUS.has(n));
  if (!names.length) return null;
  // 長的優先：「台積電」要整個吃掉，不能先被較短的名稱切走
  names.sort((a, b) => b.length - a.length);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  matcher = new RegExp(names.map(esc).join("|"), "g");
  return matcher;
}

/** 不處理這些元素裡的文字：已經是連結、表單控制項、摺疊標題。 */
const SKIP_TAGS = new Set(["a", "button", "select", "option", "title", "summary"]);

/**
 * 把 HTML 文字節點裡的公司名稱換成 Yahoo 連結。標籤、屬性、以及 SKIP_TAGS 裡的內容不動。
 *
 * @param cls 連結的 class（樣式由各頁自己的 CSS 決定）；空字串就不加 class
 */
export function linkifyStocks(html: string, cls = "stk"): string {
  const re = nameMatcher();
  if (!re) return html;
  const { byName } = load();
  const skipStack: string[] = [];
  // script／style／textarea／svg 整段原樣跳過，不逐一解析：script 裡的 `i<rows.length`
  // 會被當成標籤開頭，一路吃到 `</script>` 的 `>`，之後整頁都被誤判成還在 script 裡。
  const TOKEN = /(<(script|style|textarea|svg)\b[\s\S]*?<\/\2\s*>)|(<!--[\s\S]*?-->|<\/?([a-zA-Z][\w-]*)[^>]*>)|([^<]+)/gi;
  return html.replace(TOKEN, (whole, raw: string | undefined, _rawTag: string | undefined, tag: string | undefined, tagName: string | undefined, text: string | undefined) => {
    if (raw) return whole;
    if (tag) {
      const name = (tagName ?? "").toLowerCase();
      if (SKIP_TAGS.has(name) && !tag.endsWith("/>")) {
        if (tag.startsWith("</")) {
          const i = skipStack.lastIndexOf(name);
          if (i >= 0) skipStack.length = i;
        } else {
          skipStack.push(name);
        }
      }
      return whole;
    }
    if (!text || skipStack.length) return whole;
    return text.replace(re, (name: string, offset: number) => {
      const traps = TRAPS[name];
      if (traps?.some((t) => {
        const at = t.indexOf(name);
        return text.slice(offset - at, offset - at + t.length) === t;
      })) return name;
      const ref = byName.get(name);
      if (!ref) return name;
      return `<a${cls ? ` class="${cls}"` : ""} href="${yahooUrl(ref.code)}" target="_blank" rel="noopener">${name}</a>`;
    });
  });
}
