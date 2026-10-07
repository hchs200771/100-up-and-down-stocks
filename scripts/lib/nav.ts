/**
 * 全站導覽的唯一來源：主頁 index.html 與所有子頁吃同一份分組選單。
 *
 * 分頁和子頁加起來快 20 個，平鋪成一排會擠成三四行，所以改成「今日＋四大類」的
 * 下拉選單（NAV_GROUPS）：桌機滑鼠移上去展開、手機點一下展開；選單下方再一行列出
 * 目前所在類別的頁面，同類之間一鍵切換。
 *
 * 內部 label（含 emoji）同時是 hash 深連結（#tab=xxx）與總覽卡片 data-goto 的鍵，
 * 不能改；顯示文字由 navText 去掉 emoji、套短名。
 */
/** 網頁版的分頁順序。這是唯一的排序來源：分頁列、面板順序、總覽卡片全部吃它。 */
export const READ_ORDER = [
  "🌐 國際情勢",
  "🎙️ KOL 觀點",
  "📊 市場總覽",
  "⚖️ 指數貢獻",
  "🔥 上漲族群",
  "🔄 族群輪動",
  "🏦 大戶籌碼",
  "🎯 操作建議",
  "🏆 終極選股池",
];

/** 不在 READ_ORDER 動線上、但確實是分頁的（主頁會把它們排在最後）。 */
export const EXTRA_TABS = ["🧊 下跌族群", "📒 交易檢討"];

/** 子頁：獨立 HTML，不是 index 的分頁，所以用 <a> 而不是分頁鈕。 */
export const SUBPAGES: { file: string; label: string }[] = [
  { file: "cb-pledge.html", label: "🔐 設質+CB" },
  { file: "revenue.html", label: "📈 月營收" },
  { file: "themes.html", label: "📡 題材雷達" },
  { file: "broker-watch.html", label: "🕵️ 贏家分點" },
  { file: "revenue-decline.html", label: "📉 營收衰退" },
  { file: "revenue-industry.html", label: "🏭 營收族群" },
  { file: "target-price.html", label: "🎯 目標價" },
];

/** 太長的標籤在分頁列上用短名。只影響顯示，內部 label 不變。 */
const SHORT: Record<string, string> = {
  終極選股池: "選股池",
  "設質+CB": "設質CB",
};

/** label → 分頁列上的顯示文字：去掉開頭 emoji，再套短名表。 */
export function navText(label: string): string {
  const bare = label.replace(/^\p{Extended_Pictographic}[️‍\p{Extended_Pictographic}]*\s*/u, "").trim();
  return SHORT[bare] ?? bare;
}


/** 首頁分頁的內部 label（hash 鍵）。導覽上顯示成「今日」。 */
export const HOME_LABEL = "🏠 總覽";

/**
 * 已併進別的分頁的舊 label → 現在的分頁。舊連結（書籤、子頁快取）帶 #tab=舊名進來時，
 * 主頁照這張表轉到新位置，而不是落回首頁。
 */
export const TAB_ALIASES: Record<string, string> = {
  "🧭 長線策略": "🎯 操作建議",
};

/** 導覽項目：`tab` 是主頁分頁的 label，`file` 是 SUBPAGES 裡的子頁。 */
type NavItem = { tab: string } | { file: string };

/**
 * 四大類下拉選單。依「想回答的問題」分，不依資料來源或更新頻率分：
 * 大盤＝大環境與資金、族群＝題材輪動、個股＝候選名單、策略＝我要怎麼做。
 * SUBPAGES 新增子頁卻忘了放進這裡時，會自動補到「個股」最後，不會從導覽消失。
 */
export const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  { title: "大盤", items: [{ tab: "📊 市場總覽" }, { tab: "⚖️ 指數貢獻" }, { tab: "🌐 國際情勢" }, { tab: "🎙️ KOL 觀點" }] },
  {
    title: "族群",
    items: [{ tab: "🔥 上漲族群" }, { tab: "🧊 下跌族群" }, { tab: "🔄 族群輪動" }, { file: "themes.html" }, { file: "revenue-industry.html" }],
  },
  {
    title: "個股",
    items: [
      { tab: "🏆 終極選股池" },
      { tab: "🏦 大戶籌碼" },
      { file: "broker-watch.html" },
      { file: "target-price.html" },
      { file: "revenue.html" },
      { file: "revenue-decline.html" },
      { file: "cb-pledge.html" },
    ],
  },
  { title: "策略", items: [{ tab: "🎯 操作建議" }, { tab: "📒 交易檢討" }] },
];

function groupsWithLeftovers(): typeof NAV_GROUPS {
  const claimed = new Set(NAV_GROUPS.flatMap((g) => g.items.flatMap((i) => ("file" in i ? [i.file] : []))));
  const leftovers = SUBPAGES.filter((p) => !claimed.has(p.file)).map((p) => ({ file: p.file }));
  if (!leftovers.length) return NAV_GROUPS;
  return NAV_GROUPS.map((g) => (g.title === "個股" ? { ...g, items: [...g.items, ...leftovers] } : g));
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * 導覽樣式。主頁與子頁共用，跟著 <nav> 一起輸出，子頁不用各自維護一份。
 *
 * - 顏色走子頁的 CSS 變數（--bg/--card/--fg/--muted/--line/--accent，子頁各自有深色版），
 *   主頁沒有這些變數就落回淺色預設值，深色模式由主頁的整頁反相處理。
 * - 子頁原本的 `.nav` / `.nav a` 膠囊樣式仍在它們自己的 <style> 裡；這裡一律用兩個 class
 *   的選擇器（特異度高於 `.nav a`），並把那幾個屬性全部重設。
 * - 下拉：有滑鼠時 hover 展開（`any-hover`，不用 `hover`——觸控筆電會把主要輸入回報成
 *   觸控，`hover:hover` 就不成立）；點類別鈕一律由下方 script 切換 `.open`，手機靠這個。
 *   類別鈕的 href 指向該類第一項，只是沒有 JS 時的退路。
 *   頂層那一排**不能** overflow:auto，否則下拉會被裁掉。
 */
const NAV_CSS = `<style>
nav.gnav{display:block;position:sticky;top:0;z-index:40;margin:0 0 14px;padding:8px 0 6px;background:var(--bg,#fff);border-bottom:1px solid var(--line,#e5e7eb);font-family:inherit}
.gnav .gnav-top{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.gnav .gnav-g{position:relative}
.gnav .gnav-btn{display:inline-block;border:1px solid var(--line,#e5e7eb);border-radius:999px;padding:7px 14px;font-size:14px;font-weight:700;line-height:1.3;background:var(--card,#fff);color:var(--fg,#374151);text-decoration:none;cursor:pointer;white-space:nowrap}
.gnav .gnav-btn:hover{border-color:var(--accent,#6366f1);color:var(--accent,#4338ca)}
.gnav .gnav-btn.on{background:var(--accent,#4f46e5);border-color:var(--accent,#4f46e5);color:#fff}
.gnav .gnav-caret{font-size:10px;margin-left:4px;opacity:.7}
.gnav .gnav-menu{display:none;position:absolute;left:0;top:100%;padding-top:6px;z-index:41;min-width:168px}
.gnav .gnav-g:nth-last-child(-n+2) .gnav-menu{left:auto;right:0}
.gnav .gnav-menu-in{background:var(--card,#fff);border:1px solid var(--line,#e5e7eb);border-radius:10px;box-shadow:0 8px 24px rgba(15,23,42,.14);padding:6px}
.gnav .gnav-item{display:block;border:0;border-radius:6px;padding:8px 12px;font-size:14px;font-weight:600;line-height:1.3;background:transparent;color:var(--fg,#374151);text-decoration:none;white-space:nowrap}
.gnav .gnav-item:hover{background:var(--chip,#f1f5f9);color:var(--accent,#4338ca)}
.gnav .gnav-item.on{color:var(--accent,#4338ca);background:var(--chip,#eef2ff)}
.gnav .gnav-g.open .gnav-menu{display:block}
@media (any-hover:hover){.gnav .gnav-g:hover .gnav-menu{display:block}}
.gnav .gnav-sub{display:none;gap:4px;margin-top:6px;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.gnav .gnav-sub::-webkit-scrollbar{display:none}
.gnav .gnav-sub.on{display:flex}
.gnav .gnav-subitem{flex:none;display:inline-block;border:0;border-radius:6px;padding:4px 10px;font-size:13px;font-weight:600;line-height:1.4;background:transparent;color:var(--muted,#6b7280);text-decoration:none;white-space:nowrap}
.gnav .gnav-subitem:hover{color:var(--accent,#4338ca)}
.gnav .gnav-subitem.on{background:var(--chip,#eef2ff);color:var(--accent,#4338ca)}
@media (max-width:640px){.gnav .gnav-btn{padding:6px 11px;font-size:13px}}
</style>`;

/**
 * 子頁深色模式的底色。各子頁各自在 <head> 定義了同一組深色 token（--bg #0f1420 等），
 * 實際看起來太暗；這裡統一調亮一階，跟著導覽列輸出，因為導覽 <style> 在 <head> 之後，
 * 同特異度會蓋過去，不用改七支產生器。
 * 只給子頁：主頁的深色模式是整頁反相，在主頁定義這些變數會讓導覽列被反相成淺色。
 */
const SUBPAGE_DARK_CSS = `<style>@media (prefers-color-scheme:dark){:root{--bg:#1b2232;--card:#242d40;--line:#36425b;--chip:#2e3a52}}</style>`;

/**
 * 點擊開合下拉（手機靠這個），以及主頁切分頁時的標記。
 * 主頁的分頁切換 script 會呼叫 window.gnavMark(label) 標出目前分頁所屬的類別。
 */
const NAV_JS = `<script>(function(){
var nav=document.currentScript&&document.currentScript.parentNode;if(!nav)return;
var groups=[].slice.call(nav.querySelectorAll('.gnav-g'));
function closeAll(except){groups.forEach(function(g){if(g!==except)g.classList.remove('open');});}
groups.forEach(function(g){var b=g.querySelector('.gnav-btn');if(!b)return;
b.addEventListener('click',function(e){e.preventDefault();closeAll(g);g.classList.toggle('open');});});
document.addEventListener('click',function(e){if(!nav.contains(e.target))closeAll();});
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeAll();});
nav.addEventListener('click',function(e){if(e.target.closest&&e.target.closest('.gnav-item,.gnav-subitem'))closeAll();});
window.gnavMark=function(label){
  var gi=-1;
  [].slice.call(nav.querySelectorAll('[data-tab]')).forEach(function(a){var on=a.getAttribute('data-tab')===label;a.classList.toggle('on',on);if(on)gi=+a.getAttribute('data-g');});
  groups.forEach(function(g){g.querySelector('.gnav-btn').classList.toggle('on',+g.getAttribute('data-g')===gi);});
  [].slice.call(nav.querySelectorAll('.gnav-sub')).forEach(function(s){s.classList.toggle('on',+s.getAttribute('data-g')===gi);});
  showCurrent();
};
// 手機上小分頁列是橫向捲動的：把目前這一項捲進畫面
function showCurrent(){var on=nav.querySelector('.gnav-sub.on .gnav-subitem.on');if(!on)return;var row=on.parentNode;
if(row.scrollWidth>row.clientWidth)row.scrollLeft=on.offsetLeft-row.offsetLeft-(row.clientWidth-on.offsetWidth)/2;}
showCurrent();
})();</script>`;

/**
 * 全站導覽列 HTML。
 *
 * @param currentFile 目前頁面的檔名（主頁傳 "index.html"）。主頁的分頁連結用同頁 hash，
 *   由主頁 script 的 hashchange 切換；子頁的分頁連結回 index.html#tab=…。
 * @param currentTab 主頁伺服器端預先標記的分頁（通常是首頁），之後由 gnavMark 接手。
 */
export function renderSiteNav(currentFile: string, currentTab?: string): string {
  const onIndex = currentFile === "index.html";
  const tabHref = (label: string) => `${onIndex ? "" : "index.html"}#tab=${encodeURIComponent(label)}`;
  const groups = groupsWithLeftovers();
  const resolved = groups.map((g) =>
    g.items.map((item) => {
      if ("tab" in item) return { href: tabHref(item.tab), label: item.tab, tab: item.tab, on: onIndex && item.tab === currentTab };
      const page = SUBPAGES.find((p) => p.file === item.file);
      return { href: item.file, label: page?.label ?? item.file, tab: "", on: item.file === currentFile };
    }),
  );
  const activeGroup = resolved.findIndex((items) => items.some((i) => i.on));
  const homeOn = onIndex && activeGroup < 0;
  const dataTab = (i: { tab: string }, g: number) => (i.tab ? ` data-tab="${esc(i.tab)}" data-g="${g}"` : "");

  const top = groups
    .map((g, gi) => {
      const items = resolved[gi];
      const menu = items
        .map((i) => `<a class="gnav-item${i.on ? " on" : ""}" href="${esc(i.href)}"${dataTab(i, gi)}>${esc(i.label)}</a>`)
        .join("");
      return `<div class="gnav-g" data-g="${gi}"><a class="gnav-btn${gi === activeGroup ? " on" : ""}" href="${esc(items[0].href)}" aria-haspopup="true">${g.title}<span class="gnav-caret">▾</span></a><div class="gnav-menu"><div class="gnav-menu-in">${menu}</div></div></div>`;
    })
    .join("");
  const subs = groups
    .map((_g, gi) => {
      const links = resolved[gi]
        .map((i) => `<a class="gnav-subitem${i.on ? " on" : ""}" href="${esc(i.href)}"${dataTab(i, gi)}>${esc(navText(i.label))}</a>`)
        .join("");
      return `<div class="gnav-sub${gi === activeGroup ? " on" : ""}" data-g="${gi}">${links}</div>`;
    })
    .join("");
  const homeHref = onIndex ? tabHref(HOME_LABEL) : "index.html";
  return `<nav class="nav gnav">${NAV_CSS}${onIndex ? "" : SUBPAGE_DARK_CSS}<div class="gnav-top"><a class="gnav-btn gnav-home${homeOn ? " on" : ""}" href="${homeHref}" data-tab="${esc(HOME_LABEL)}" data-g="-1">今日</a>${top}</div>${subs}${NAV_JS}</nav>`;
}

/** 子頁用的導覽列（舊名保留給各子頁產生器呼叫）。 */
export function renderSubpageNav(currentFile: string): string {
  return renderSiteNav(currentFile);
}

/** 取代頁面裡現有的導覽列（新舊兩種 <nav> 都認得）。找不到就回傳 null。 */
export const NAV_BLOCK_RE = /<nav class="nav(?: gnav)?">[\s\S]*?<\/nav>/;
