/**
 * npx tsx scripts/tag-broker-geo.ts [--offline]
 * Cache-first: remove data/cache/geo files explicitly to refresh official data.
 * --offline forbids downloads and fails if a required cache is missing.
 * Does not run the daily report or update Notion.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

type Row = Record<string, string>;
type Location = { city: string; district: string; address: string };
type Site = Location & { type: "HQ" | "factory" };
type Branch = Location & { source: "TWSE" | "broker" | "name" | "unknown" };
type Geo = "地緣" | "同生活圈" | "否" | "未知";
type Watch = { pageId: string; stockCode: string; stockName: string; broker: string; brokerCode: string };
const CACHE = resolve(process.cwd(), "data/cache/geo");
const normalize = (s: string) => s.normalize("NFKC").replace(/臺/g, "台").replace(/巿/g, "市").replace(/\s/g, "");
const companyName = (s: string) => normalize(s).replace(/\(股\)公司/g, "股份有限公司");

async function cached(name: string, url: string, offline: boolean): Promise<Buffer> {
  const path = resolve(CACHE, name);
  if (existsSync(path)) {
    console.log(`[cache] ${name}`);
    return readFileSync(path);
  }
  if (offline) throw new Error(`離線快取缺少 ${name}`);
  console.log(`[download] ${name}: ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  // Reject error pages before they can poison the offline cache.
  if (!bytes.length || (!name.endsWith(".html") && /<!doctype html|<html/i.test(bytes.subarray(0, 300).toString()))) {
    throw new Error(`${name}: 預期資料檔，收到空檔或 HTML`);
  }
  if (name.endsWith(".json")) {
    if (!Array.isArray(JSON.parse(bytes.toString()))) throw new Error(`${name}: 預期 JSON array`);
  }
  if (name.endsWith(".zip") && bytes.readUInt32LE(0) !== 0x04034b50) throw new Error(`${name}: 非 ZIP`);
  writeFileSync(`${path}.tmp`, bytes);
  renameSync(`${path}.tmp`, path);
  return bytes;
}

/** RFC 4180: quoted commas, escaped quotes and embedded newlines. */
export function parseCsv(text: string): Row[] {
  const records: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (ch === "," || ch === "\n" || ch === "\r")) {
      row.push(cell); cell = "";
      if (ch !== ",") {
        if (row.some(Boolean)) records.push(row);
        row = [];
        if (ch === "\r" && text[i + 1] === "\n") i++;
      }
    } else cell += ch;
  }
  if (quoted) throw new Error("CSV 引號未結束");
  row.push(cell);
  if (row.some(Boolean)) records.push(row);
  const headers = records.shift() ?? [];
  return records.map(values => Object.fromEntries(headers.map((key, i) => [key.trim(), values[i]?.trim() ?? ""])));
}

function requireFields(rows: Row[], fields: string[], source: string) {
  if (!rows.length || fields.some(key => !(key in rows[0]))) throw new Error(`${source}: 欄位變動或資料為空 (${fields.join("、")})`);
}

const CITIES = "台北市 新北市 桃園市 台中市 台南市 高雄市 新竹市 新竹縣 基隆市 苗栗縣 彰化縣 南投縣 雲林縣 嘉義市 嘉義縣 屏東縣 宜蘭縣 花蓮縣 台東縣 澎湖縣 金門縣 連江縣".split(" ");
const OLD_CITIES: Record<string, string> = { 台北縣: "新北市", 桃園縣: "桃園市", 台中縣: "台中市", 台南縣: "台南市", 高雄縣: "高雄市" };
const COUNTY_SEATS: Record<string, string> = { 苗栗市: "苗栗縣", 彰化市: "彰化縣", 南投市: "南投縣", 斗六市: "雲林縣", 屏東市: "屏東縣", 宜蘭市: "宜蘭縣", 花蓮市: "花蓮縣", 台東市: "台東縣", 馬公市: "澎湖縣" };

export function parseAddress(address: string): Location {
  let text = normalize(address);
  let old = false;
  for (const [from, to] of Object.entries(OLD_CITIES)) {
    if (text.includes(from)) { text = text.replace(from, to); old = true; }
  }
  text = text.replace(/^北市/, "台北市");
  let city = CITIES.find(value => text.includes(value)) ?? "";
  let district = "";
  if (city) {
    const rest = text.slice(text.indexOf(city) + city.length);
    // Anchor at the city: never confuse 科學園區/工業區 or street names with a district.
    // Prefer 區: 新市區/前鎮區 contain a different administrative suffix.
    district = rest.match(/^([\p{Script=Han}]{1,3}?區|[\p{Script=Han}]{1,3}?[鄉鎮市])/u)?.[1] ?? "";
    if (["園區", "科學園區", "工業區"].includes(district)) district = "";
    if (old && ["新北市", "桃園市", "台中市", "台南市", "高雄市"].includes(city)) {
      district = district.replace(/[鄉鎮市]$/, "區");
    }
  } else {
    const seat = Object.keys(COUNTY_SEATS).find(value => text.replace(/^\(?\d+\)?/, "").startsWith(value));
    if (seat) { city = COUNTY_SEATS[seat]; district = seat; }
  }
  if (city === "苗栗縣" && district === "頭份鎮") district = "頭份市";
  if (city === "彰化縣" && district === "員林鎮") district = "員林市";
  // Addresses explicitly identifying the original Hsinchu park, without a city/district.
  if (/新竹(?:科學(?:工業)?園區|市科學園區)/.test(text)) {
    if (!city) city = "新竹市";
    if (!district && city === "新竹市") district = "東區";
    if (!district && city === "新竹縣") district = "寶山鄉";
  }
  return { city, district, address };
}

// Administrative district enrichment for incomplete TWSE street addresses. These
// apply only to the stated city + street/section, never to a branch name globally.
// Number-specific exceptions precede broader street rules (roads cross boundaries).
const STREET_DISTRICTS: [string, RegExp, string][] = [
  ["台北市", /復興南路1段2號/, "松山區"],
  ["台北市", /忠孝東路4段(?:563|565)/, "信義區"],
  ["台北市", /忠孝東路4段/, "大安區"],
  ["台北市", /忠孝東路5段|松智路/, "信義區"],
  ["台北市", /忠孝東路2段|重慶南路|許昌街|博愛路|武昌街/, "中正區"],
  ["台北市", /羅斯福(?:路)?2段9號/, "中正區"],
  ["台北市", /羅斯福(?:路)?2段91號|敦化南路|仁愛路4段|和平東路3段|安和路1段/, "大安區"],
  ["台北市", /八德路4段|南京東路五段|民生東路3段128號/, "松山區"],
  ["台北市", /中山北路[23二三]段|長安東路一段|南京東路2段|八德路二段/, "中山區"],
  ["台北市", /迪化街1段|承德路一段/, "大同區"],
  ["台北市", /木柵路3段/, "文山區"],
  ["台北市", /文林路342號/, "士林區"],
  ["台北市", /內湖路1段/, "內湖區"],
  ["台中市", /五權西路(?:一|1)段237號|五權西路一段二三七號|五權西路一段257號|自由路1段/, "西區"],
  ["台中市", /五權西路2段668號/, "南屯區"],
  ["台南市", /安和路二段/, "安南區"],
  ["台南市", /民生路2段|西門路1段655號|忠義路2段|永華路1段32號/, "中西區"],
  ["台南市", /成功路114號|開元路280號/, "北區"],
  ["台南市", /林森路1段395號/, "東區"],
  ["高雄市", /中正四路235號|河東路165號/, "前金區"],
  ["高雄市", /博愛一路391號/, "三民區"],
  ["新竹市", /中正路(?:158|129)號/, "北區"],
  ["新竹市", /信義街68號|光復路1段/, "東區"],
  ["基隆市", /仁二路255號/, "仁愛區"],
];

function completeAddress(address: string): Location {
  const location = parseAddress(address);
  if (!location.district) {
    location.district = STREET_DISTRICTS.find(([city, pattern]) => city === location.city && pattern.test(normalize(address)))?.[2] ?? "";
  }
  return location;
}

const NAME_LOCATIONS: Record<string, string> = {
  中壢: "桃園市中壢區", 桃園: "桃園市桃園區", 青埔: "桃園市中壢區", 林園: "高雄市林園區",
  竹科: "新竹市東區", 新竹: "新竹市", 竹北: "新竹縣竹北市", 路竹: "高雄市路竹區",
  民權: "台北市", 天母: "台北市士林區", 台北: "台北市", 台中: "台中市", 台南: "台南市",
  北高雄: "高雄市", 高雄: "高雄市", 嘉義: "嘉義市", 苗栗: "苗栗縣苗栗市", 羅東: "宜蘭縣羅東鎮",
};
function normalizedBroker(s: string) {
  return normalize(s).replace(/證券(?:股份有限)?公司|證券|[（(]總公司[）)]/g, "").replace(/[－—]/g, "-");
}

function findBranch(item: Watch, branches: Row[], brokers: Row[], taishinHtml: string): Branch {
  // Codes are case sensitive (700B 板橋 and 700b 中壢 are different).
  const rows = [...branches.map(r => ({ code: r["證券商代號"], name: r["證券商名稱"], address: r["地址"] })),
    ...brokers.map(r => ({ code: r.Code, name: r.Name, address: r.Address }))];
  const byName = rows.filter(r => normalizedBroker(r.name) === normalizedBroker(item.broker));
  const match = rows.find(r => item.brokerCode && r.code === item.brokerCode) ?? (byName.length === 1 ? byName[0] : undefined);
  if (match) {
    const location = completeAddress(match.address);
    if (location.city) return { ...location, source: "TWSE" };
  }
  // TWSE omits this operating desk. Only use the broker's explicitly matching row.
  // https://www.tssco.com.tw/TSHOLDINGSMERGE/locations/index.html
  if (item.brokerCode === "9B17" && normalizedBroker(item.broker) === "台新-營業部") {
    const row = [...taishinHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .find(m => /<td[^>]*>\s*9B17\s*<\/td>/.test(m[1]))?.[1];
    const cells = row ? [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, "").trim()) : [];
    const address = cells.find(c => /^台北市中山區/.test(c));
    if (address) return { ...completeAddress(address), source: "broker" };
  }
  const suffix = normalize(item.broker).split("-").at(-1) ?? "";
  const inferred = NAME_LOCATIONS[suffix];
  if (inferred) return { ...parseAddress(inferred), address: match?.address ?? "", source: "name" };
  return { city: "", district: "", address: match?.address ?? "", source: "unknown" };
}

// Separate physical campuses share one zone, per the requested geographic rule.
// A park's name in an address alone must not turn 龍潭/竹南 into the Hsinchu campus.
function parkZones(location: Location, brokerName = ""): Set<string> {
  const { city, district } = location;
  const zones = new Set<string>();
  if ((city === "新竹市" && district === "東區") ||
      (city === "新竹縣" && ["寶山鄉", "竹北市"].includes(district)) ||
      (/-(竹科|新竹|竹北)$/.test(normalize(brokerName)) && ["新竹市", "新竹縣"].includes(city))) zones.add("竹科");
  if ((city === "台中市" && ["西屯區", "大雅區"].includes(district)) ||
      (city === "彰化縣" && district === "二林鎮") || (city === "雲林縣" && district === "虎尾鎮")) zones.add("中科");
  if ((city === "台南市" && ["新市區", "善化區", "安定區"].includes(district)) ||
      (city === "高雄市" && ["路竹區", "橋頭區"].includes(district))) zones.add("南科");
  return zones;
}

const NEIGHBORS = [
  ["台北市", "新北市"], ["桃園市", "新北市"], ["新竹市", "新竹縣"],
  ["台中市", "彰化縣"], ["台南市", "高雄市"],
];
export function classify(sites: Site[], branch: Branch, brokerName: string): { geo: Geo; reason: string } {
  const known = sites.filter(s => s.city);
  if (!branch.city || !known.length) return { geo: "未知", reason: !branch.city ? "分點位置未能確定" : "公司位置未能確定" };
  const branchZones = parkZones(branch, brokerName);
  const candidates = known.map(site => {
    let rank = 0, rule = "不同縣市";
    if (site.city === branch.city && site.district && site.district === branch.district) { rank = 4; rule = "同行政區"; }
    else if ([...parkZones(site)].some(z => branchZones.has(z))) { rank = 3; rule = "同科學園區生活帶"; }
    else if (site.city === branch.city && !["台北市", "新北市"].includes(site.city)) { rank = 2; rule = "同縣市"; }
    else if (site.city === branch.city || NEIGHBORS.some(pair => pair.includes(site.city) && pair.includes(branch.city))) { rank = 1; rule = "同生活圈"; }
    return { site, rank, rule };
  }).sort((a, b) => b.rank - a.rank);
  const { site, rank, rule } = candidates[0];
  return {
    geo: rank >= 2 ? "地緣" : rank === 1 ? "同生活圈" : "否",
    reason: `${site.type === "HQ" ? "總部" : "工廠"}：${site.city}${site.district}；分點：${branch.city}${branch.district}（${rule}）${branch.source === "name" ? "；分點依名稱推定" : ""}`,
  };
}

// Explicit subsidiary aliases only: do not fuzzy-match unrelated companies (e.g.
// 川湖塑膠, 世芯企業). Evidence: https://www.zdtco.com/public/tw/about and
// https://www.zdtco.com/public/index.php/tw/about/group ; BizLink's history:
// https://www.bizlinktech.com/zh-tw/company-overview (1996 Taiwan legal name).
const FACTORY_ALIASES: Record<string, string[]> = {
  "4958": ["臻鼎科技股份有限公司", "先豐通訊股份有限公司", "鵬鼎科技股份有限公司"],
  "3665": ["貿聯國際股份有限公司"],
};

export async function main() {
  mkdirSync(CACHE, { recursive: true });
  const offline = process.argv.includes("--offline");
  const download = (name: string, url: string) => cached(name, url, offline);
  const [listedBytes, otcBytes, otcZhBytes, branchBytes, brokerBytes, factoryIndexBytes, taishinBytes] = await Promise.all([
    download("listed.json", "https://openapi.twse.com.tw/v1/opendata/t187ap03_L"),
    download("otc.json", "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O"),
    // TPEx OpenAPI Address is English. MOPS's official CSV supplies Chinese 住址.
    download("otc-zh.csv", "https://mopsfin.twse.com.tw/opendata/t187ap03_O.csv"),
    download("branches.json", "https://openapi.twse.com.tw/v1/opendata/OpenData_BRK02"),
    download("brokers.json", "https://openapi.twse.com.tw/v1/brokerService/brokerList"),
    // data.gov.tw/dataset/6569 points to this index, not directly to factory rows.
    download("factory-index.csv", "https://www.ida.gov.tw/opendata/02/SDD6569.csv"),
    download("taishin-locations.html", "https://www.tssco.com.tw/TSHOLDINGSMERGE/locations/index.html"),
  ]);
  const listed: Row[] = JSON.parse(listedBytes.toString());
  const otc: Row[] = JSON.parse(otcBytes.toString());
  const otcZh = parseCsv(otcZhBytes.toString());
  const branches: Row[] = JSON.parse(branchBytes.toString());
  const brokers: Row[] = JSON.parse(brokerBytes.toString());
  requireFields(listed, ["公司代號", "公司名稱", "住址"], "TWSE");
  requireFields(otc, ["SecuritiesCompanyCode", "CompanyName", "Address"], "TPEx");
  requireFields(otcZh, ["公司代號", "公司名稱", "住址"], "MOPS OTC");
  requireFields(branches, ["證券商代號", "證券商名稱", "地址"], "TWSE branches");
  requireFields(brokers, ["Code", "Name", "Address"], "TWSE brokers");
  const factoryIndex = parseCsv(factoryIndexBytes.toString());
  requireFields(factoryIndex, ["下載連結"], "MOEA index");
  const factoryUrl = factoryIndex.find(r => /\.zip(?:$|\?)/i.test(r["下載連結"]))?.["下載連結"];
  if (!factoryUrl || new URL(factoryUrl).hostname !== "serv.gcis.nat.gov.tw") throw new Error("MOEA 工廠下載網址異動");
  await download("factories.zip", factoryUrl);
  // unzip is available on macOS/Linux; no dependency or separate extracted copy.
  const archive = resolve(CACHE, "factories.zip");
  const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" }).trim().split(/\r?\n/).filter(n => /\.csv$/i.test(n));
  if (entries.length !== 1) throw new Error("MOEA ZIP 預期一個 CSV，請檢查格式");
  const factories = parseCsv(execFileSync("unzip", ["-p", archive, entries[0]], { maxBuffer: 128 * 1024 * 1024 }).toString("utf8"));
  requireFields(factories, ["工廠名稱", "工廠地址", "統一編號", "工廠登記狀態"], "MOEA factories");
  const activeFactories = factories.filter(r => r["工廠登記狀態"] === "生產中")
    .map(row => ({ row, name: companyName(row["工廠名稱"]) }));
  const companies = new Map([...listed, ...otcZh].map(r => [r["公司代號"], r]));
  const watch: Watch[] = JSON.parse(readFileSync(resolve("data/broker-watch-config.json"), "utf8")).items;
  if (!Array.isArray(watch)) throw new Error("watchlist.items 必須是陣列");
  const siteCache = new Map<string, { sites: Site[]; warning: string }>();
  for (const item of watch) {
    if (siteCache.has(item.stockCode)) continue;
    const company = companies.get(item.stockCode);
    const sites: Site[] = [];
    if (company) sites.push({ type: "HQ", ...completeAddress(company["住址"]) });
    const names = [company?.["公司名稱"] ?? "", ...(FACTORY_ALIASES[item.stockCode] ?? [])].filter(Boolean).map(companyName);
    const taxId = company?.["營利事業統一編號"];
    const matched = activeFactories.filter(({ row, name }) =>
      (taxId && row["統一編號"] === taxId) || names.some(n => name.startsWith(n))
    ).map(({ row }) => row);
    for (const row of matched) {
      const location = completeAddress(row["工廠地址"]);
      if (!sites.some(s => s.type === "factory" && s.city === location.city && s.district === location.district)) {
        sites.push({ type: "factory", ...location });
      }
    }
    const warning = !company ? "公司基本資料未匹配" : !matched.length ? `${item.stockName.includes("KY") ? "KY台灣子公司／" : ""}工廠清冊未匹配` : "";
    if (warning) console.warn(`[warning] ${item.stockCode} ${item.stockName}: ${warning}`);
    siteCache.set(item.stockCode, { sites, warning });
  }
  const items = watch.map(({ pageId, stockCode, stockName, broker, brokerCode }) => {
    const { sites: companySites, warning } = siteCache.get(stockCode)!;
    const branch = findBranch({ pageId, stockCode, stockName, broker, brokerCode }, branches, brokers, taishinBytes.toString());
    const result = classify(companySites, branch, broker);
    return { pageId, stockCode, stockName, broker, brokerCode, ...result,
      reason: `${result.reason}${warning ? `；${warning}` : ""}`, companySites, branch };
  });
  const output = resolve("data/broker-geo.json");
  writeFileSync(output, JSON.stringify({ generatedAt: new Date().toISOString(), items }, null, 2) + "\n");
  console.log(`\n已寫入 ${output} (${items.length} pairs)`);
  for (const geo of ["地緣", "同生活圈", "否", "未知"] as Geo[]) console.log(`${geo}: ${items.filter(i => i.geo === geo).length}`);
  console.log("\n地緣名單：");
  for (const item of items.filter(i => i.geo === "地緣")) console.log(`${item.stockCode} ${item.stockName} / ${item.broker} — ${item.reason}`);
  for (const item of items.filter(i => !i.branch.district || i.companySites.some(s => !s.city || !s.district))) {
    console.warn(`[location] ${item.stockCode} ${item.broker}: 部分行政區未載，保留空字串；${item.reason}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
