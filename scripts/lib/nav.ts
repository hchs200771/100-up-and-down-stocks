/**
 * 分頁列（麵包屑）的唯一來源。
 *
 * 主頁 index.html 的分頁是 JS 動態生成的，兩個子頁（設質+CB、月營收）是靜態 HTML。
 * 以前子頁各自硬寫一份只有 5 個連結的簡化版，結果從月營收頁切不回「下跌族群」「指數
 * 貢獻」「選股池」——三個頁面的導覽長得不一樣。這支把清單集中起來，主頁與子頁吃同一份。
 *
 * 顯示規則：
 *  - **不顯示 emoji**。中文標籤本身就夠辨識，emoji 每個吃掉約 26px，11 個分頁就是快 300px，
 *    正是分頁列擠到第二行的主因。emoji 仍留在內部 label 裡，因為它同時是 hash 深連結
 *    （#tab=xxx）與總覽卡片 data-goto 的鍵，改掉會讓舊連結失效。
 *  - 少數過長的標籤縮短（見 SHORT），讓一行放得下。
 */

/** 網頁版的分頁順序。這是唯一的排序來源：分頁列、面板順序、總覽卡片全部吃它。 */
export const READ_ORDER = [
  "🌐 國際情勢",
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
];

/** 子頁要呈現的完整分頁清單，順序與主頁一致。 */
export const TAB_ORDER = ["🏠 總覽", ...READ_ORDER, ...EXTRA_TABS];

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

/** 分頁鈕與子頁連結共用的樣式，主頁的 JS 版本要跟這裡保持一致。 */
export const PILL_CSS =
  "font-family:inherit;font-size:13px;font-weight:bold;cursor:pointer;border:1px solid #e5e7eb;border-radius:999px;padding:7px 12px;background:#fff;color:#374151;";

/**
 * 子頁用的分頁列 HTML。分頁連回 index.html 的對應 hash，子頁彼此直接互連，
 * 當前這一頁標成 here。樣式類別沿用子頁自己的 .nav（兩個子頁的 CSS 一致）。
 */
export function renderSubpageNav(currentFile: string): string {
  const tabs = TAB_ORDER.map((label) => {
    const hash = label === "🏠 總覽" ? "" : `#tab=${encodeURIComponent(label)}`;
    return `<a href="index.html${hash}">${navText(label)}</a>`;
  });
  const subs = SUBPAGES.map(
    ({ file, label }) =>
      `<a${file === currentFile ? ' class="here"' : ""} href="${file}">${navText(label)}${file === currentFile ? "" : " ↗"}</a>`,
  );
  return `<nav class="nav">${[...tabs, ...subs].join("")}</nav>`;
}
