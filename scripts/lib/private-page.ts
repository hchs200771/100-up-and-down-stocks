/**
 * 私人子頁（目前只有交易檢討）：內容在發布前用密碼加密，網站與 repo 上只有密文。
 *
 * - 金鑰：PBKDF2-SHA256（600,000 次）從密碼導出 AES-GCM 256 金鑰，每次發布換新的 salt / IV。
 * - 頁面外殼（導覽列、樣式、密碼框）是明文；輸入密碼後在瀏覽器用 Web Crypto 解開內容。
 * - 「記住這台裝置」把密碼存在 localStorage，不勾就只存 sessionStorage（關分頁即忘）；
 *   同網站的私人頁共用，解開一頁之後其他頁會自動解開。
 * - 密文是公開的，別人可以離線猜密碼，所以密碼要夠長（建議 4～5 個隨機單字）。
 * - 解開的內容用 innerHTML 塞進頁面，裡面的 <script> 不會執行，內容只能是靜態 HTML/SVG。
 */
import { renderSubpageNav } from "./nav";

const ITERATIONS = 600_000;

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

export async function encryptHtml(html: string, password: string) {
  const { subtle } = globalThis.crypto;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(html)));
  return { n: ITERATIONS, s: b64(salt), i: b64(iv), c: b64(ct) };
}

/** 私人頁共用的樣式：沿用子頁的 CSS 變數與深色版。 */
export const PRIVATE_CSS = `
:root{--bg:#f7f8fa;--card:#fff;--fg:#1a202c;--muted:#64748b;--line:#e2e8f0;--accent:#2563eb;--up:#dc2626;--down:#16a34a;--chip:#eef2f7}
@media (prefers-color-scheme:dark){:root{--bg:#0f1420;--card:#171e2e;--fg:#e5eaf3;--muted:#8b98ad;--line:#28334a;--accent:#7aa2ff;--up:#f87171;--down:#4ade80;--chip:#222c42}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"PingFang TC","Noto Sans TC",sans-serif;padding:16px}
.wrap{max-width:960px;margin:0 auto}
h1{font-size:20px;margin:4px 0 2px}
h2{font-size:16px;margin:22px 0 8px}
.sub,.note{color:var(--muted);font-size:13px;margin:2px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin-bottom:8px}
.card .t{font-weight:700}
.card .body{font-size:13.5px;line-height:1.75;margin-top:3px}
.chip{display:inline-block;background:var(--chip);border-radius:99px;padding:0 8px;font-size:11px;color:var(--muted);margin-left:4px}
.cards{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}
.cards .card{flex:1 1 160px;margin:0}
.cards .card b{display:block;font-size:18px;margin-top:4px}
.pos{color:var(--up)}.neg{color:var(--down)}
.tablebox{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:640px;font-size:13px}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th:first-child,td:first-child,td.l{text-align:left}
td.l{white-space:normal}
th{color:var(--muted);font-weight:600}
.lock{max-width:360px;margin:48px auto;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}
.lock input[type=password]{width:100%;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);margin:10px 0}
.lock button{font:inherit;font-weight:700;padding:7px 16px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
.lock label{font-size:13px;color:var(--muted);display:flex;align-items:center;gap:6px;margin-bottom:12px}
.lock .err{color:var(--up);font-size:13px;min-height:1.4em;margin-top:8px}
.relock{float:right;font-size:12px;color:var(--muted);background:none;border:1px solid var(--line);border-radius:999px;padding:2px 10px;cursor:pointer}
`;

const DECRYPT_JS = `<script>
(function(){
  var KEY="private-page-pw";
  var enc=JSON.parse(document.getElementById("enc").textContent);
  var form=document.getElementById("lockform"),box=document.getElementById("content"),err=document.getElementById("err");
  var d=function(s){return Uint8Array.from(atob(s),function(c){return c.charCodeAt(0)})};
  function store(){try{return localStorage.getItem(KEY)||sessionStorage.getItem(KEY)}catch(e){return null}}
  async function unlock(pw){
    var base=await crypto.subtle.importKey("raw",new TextEncoder().encode(pw),"PBKDF2",false,["deriveKey"]);
    var key=await crypto.subtle.deriveKey({name:"PBKDF2",salt:d(enc.s),iterations:enc.n,hash:"SHA-256"},base,{name:"AES-GCM",length:256},false,["decrypt"]);
    var pt=await crypto.subtle.decrypt({name:"AES-GCM",iv:d(enc.i)},key,d(enc.c));
    box.innerHTML=new TextDecoder().decode(pt);
    form.style.display="none";box.style.display="";
  }
  form.addEventListener("submit",async function(e){
    e.preventDefault();err.textContent="解密中…";
    var pw=form.pw.value;
    try{
      await unlock(pw);err.textContent="";
      try{(form.remember.checked?localStorage:sessionStorage).setItem(KEY,pw)}catch(x){}
    }catch(x){err.textContent="密碼不對"}
  });
  window.relock=function(){try{localStorage.removeItem(KEY);sessionStorage.removeItem(KEY)}catch(x){}location.reload()};
  var saved=store();
  if(saved)unlock(saved).catch(function(){form.style.display=""});else form.style.display="";
})();
</script>`;

/**
 * 組出私人頁。password 為空時不輸出內容，只放一句說明——絕不發布明文。
 */
export async function renderPrivatePage(opts: { file: string; title: string; icon: string; contentHtml: string; password?: string }) {
  const head = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title}</title>
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="88">${opts.icon}</text></svg>`)}">
<style>${PRIVATE_CSS}</style>
</head>
<body>
<div class="wrap">
${renderSubpageNav(opts.file)}`;
  if (!opts.password) {
    return `${head}
<div class="lock"><h1>🔒 ${opts.title}</h1><p class="note">尚未設定 SITE_PASSWORD，這頁不發布內容。</p></div>
</div>
</body>
</html>
`;
  }
  const enc = await encryptHtml(opts.contentHtml, opts.password);
  return `${head}
<form class="lock" id="lockform" style="display:none" autocomplete="on">
  <h1>🔒 ${opts.title}</h1>
  <p class="note">私人頁面，輸入密碼後在這台裝置上解密。</p>
  <input type="text" name="username" value="site" autocomplete="username" hidden>
  <input type="password" name="pw" autocomplete="current-password" placeholder="密碼" required autofocus>
  <label><input type="checkbox" name="remember">記住這台裝置</label>
  <button type="submit">解鎖</button>
  <div class="err" id="err"></div>
</form>
<div id="content" style="display:none"></div>
<script type="application/json" id="enc">${JSON.stringify(enc)}</script>
${DECRYPT_JS}
</div>
</body>
</html>
`;
}
