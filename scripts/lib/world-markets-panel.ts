import { readFileSync } from "node:fs";
import { WORLD_MARKET_GROUPS } from "./world-markets";

function marketCards(markets: readonly { symbol: string; name: string; note?: string }[]) {
  return markets.map(({ symbol, name, note }) => `<article class="wm-card">
    <h5>${name}</h5>
    ${note ? `<p>${note}</p>` : ""}
    <div class="wm-chart" data-symbol="${symbol}"></div>
  </article>`).join("");
}

export function renderWorldMarketsPanel(): string {
  const legend = `<p>綠＝收漲、紅＝收跌（美股慣例，與台股相反）。收盤等於或高於開盤為綠，低於開盤為紅。</p>`;
  const groups = WORLD_MARKET_GROUPS.map(({ name, markets }) => `
    <section>
      <h4>${name}</h4>
      <div class="wm-grid">${marketCards(markets)}</div>
    </section>`).join("");
  const script = readFileSync(new URL("./world-markets-browser.js", import.meta.url), "utf-8");

  return `<section id="world-markets">
    <style>
      #world-markets { --wm-panel:#fff; --wm-text:#1e293b; --wm-muted:#475569; --wm-border:#cbd5e1;
        --wm-ma20:#a14b00; --wm-ma60:#7c3aed; --wm-bull:#166534; --wm-bear:#b91c1c;
        --wm-up:#15803d; --wm-down:#b91c1c;
        margin-bottom:16px; color:var(--wm-text); }
      /* 深色模式沿用首頁 .rpt 的整頁反相。 */
      #world-markets .wm-panel, #world-markets .wm-card { background:var(--wm-panel);
        border:1px solid var(--wm-border); border-radius:8px; padding:12px; min-width:0; }
      #world-markets details { margin-top:10px; }
      #world-markets summary { cursor:pointer; font-weight:700; }
      #world-markets h5 { margin:0 0 6px; color:var(--wm-text); font-size:inherit; }
      #world-markets h4 { margin:12px 0 6px; color:var(--wm-text); }
      #world-markets p { margin:4px 0; font-size:13px; color:var(--wm-muted); }
      #world-markets .wm-legend { display:flex; flex-wrap:wrap; gap:4px 14px; }
      #world-markets .wm-legend span::before { content:""; display:inline-block; width:17px; margin-right:5px;
        vertical-align:middle; border-top:1.5px solid currentColor; }
      #world-markets .wm-legend .wm-ma20 { color:var(--wm-ma20); }
      #world-markets .wm-legend .wm-ma60 { color:var(--wm-ma60); }
      /* 一列一張圖：兩張並排太擠，看不清頸線 */
      #world-markets .wm-grid { display:grid; grid-template-columns:minmax(0,1fr); gap:8px; }
      #world-markets .wm-status { font-weight:700; color:var(--wm-text); }
      #world-markets .wm-status[data-trend="above"] { color:var(--wm-bull); }
      #world-markets .wm-status[data-trend="below"] { color:var(--wm-bear); }
      #world-markets .wm-readout { min-height:2.9em; line-height:1.45; font-variant-numeric:tabular-nums; }
      #world-markets svg { display:block; width:100%; overflow:visible; touch-action:pan-y; cursor:crosshair; }
      #world-markets svg text { fill:var(--wm-muted); font:11px system-ui,sans-serif; }
      #world-markets svg path, #world-markets svg line { fill:none; }
      #world-markets .wm-gridline { stroke:var(--wm-border); }
      #world-markets .wm-up { color:var(--wm-up); }
      #world-markets .wm-down { color:var(--wm-down); }
      #world-markets .wm-wick { stroke:currentColor; }
      #world-markets .wm-body { fill:currentColor; }
      #world-markets .wm-ma20-line, #world-markets .wm-ma60-line { stroke-width:1.5; stroke-dasharray:none; }
      #world-markets .wm-ma20-line { stroke:var(--wm-ma20); }
      #world-markets .wm-ma60-line { stroke:var(--wm-ma60); }
      #world-markets svg .wm-extreme { paint-order:stroke; stroke:var(--wm-panel); stroke-width:3;
        stroke-linejoin:round; font-weight:700; pointer-events:none; }
      #world-markets .wm-high { fill:var(--wm-bull); }
      #world-markets .wm-low { fill:var(--wm-bear); }
      #world-markets .wm-cursor { stroke:var(--wm-muted); stroke-dasharray:3 3; }
      #world-markets svg .wm-price { fill:currentColor; font-size:12px; font-weight:700; paint-order:stroke;
        stroke:var(--wm-panel); stroke-width:3; stroke-linejoin:round; pointer-events:none; }
    </style>
    <details class="wm-panel wm-world">
      <summary>各國股市專區</summary>
      ${legend}
      <p>近 12 個月日 K。均線是近 20 或 60 個交易日的平均收盤，60 日約一季。移動滑鼠或手指可查看開、高、低、收與相對前一交易日收盤的漲跌幅。</p>
      <p class="wm-load" role="status"></p>
      ${groups}
    </details>
    <script>${script}</script>
  </section>`;
}
