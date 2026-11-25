(() => {
  const root = document.getElementById("world-markets");
  const worldDetails = root.querySelector(".wm-world");
  const loadStatus = worldDetails.querySelector(".wm-load");
  const number = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 });
  const charts = new WeakMap();
  let loading = false;
  let loaded = false;

  function signed(value) {
    return (value > 0 ? "+" : value < 0 ? "−" : "") + Math.abs(value).toFixed(2) + "%";
  }

  function oneYearAgo(date) {
    const end = new Date(date);
    const month = new Date(Date.UTC(end.getUTCFullYear() - 1, end.getUTCMonth(), 1));
    const lastDay = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
    month.setUTCDate(Math.min(end.getUTCDate(), lastDay));
    return month.toISOString().slice(0, 10);
  }

  function plot(target) {
    const state = charts.get(target);
    const width = target.clientWidth;
    if (!state || !width || state.width === width || !target.closest("details").open) return;
    state.width = width;

    const points = state.points;
    const height = target.clientWidth < 500 ? 200 : 280;
    const values = points.flatMap(({ high, low, ma20, ma60 }) => [high, low, ma20, ma60]).filter(Number.isFinite);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const padding = (max - min) * 0.06 || max * 0.01;
    const step = (max + padding - (min - padding)) / 3;
    const left = Math.max(number.format(max).length * 7 + 7, 45);
    const right = width - 8;
    const top = 18;
    const bottom = height - 34;
    const slot = (right - left) / points.length;
    const bodyWidth = Math.min(8, slot * 0.7);
    const x = (i) => left + (i + 0.5) * slot;
    const y = (value) => bottom - (value - min + padding) / (3 * step) * (bottom - top);
    const grid = Array.from({ length: 4 }, (_, index) => {
      const value = min - padding + step * index;
      const yy = y(value);
      return '<line class="wm-gridline" x1="' + left + '" x2="' + right + '" y1="' + yy + '" y2="' + yy + '"/>' +
        '<text x="' + (left - 5) + '" y="' + (yy + 4) + '" text-anchor="end">' + number.format(value) + '</text>';
    }).join("");
    const tickCount = Math.min(points.length, width < 440 ? 3 : 5);
    const dates = Array.from({ length: tickCount }, (_, index) => {
      const i = Math.round(index / Math.max(tickCount - 1, 1) * (points.length - 1));
      const anchor = index === 0 ? "start" : index === tickCount - 1 ? "end" : "middle";
      return '<text x="' + x(i) + '" y="' + (height - 4) + '" text-anchor="' + anchor + '">' + points[i].date.slice(5).replace("-", "/") + '</text>';
    }).join("");
    function line(key) {
      let drawing = false;
      const path = points.map((point, i) => {
        if (point[key] == null) {
          drawing = false;
          return "";
        }
        const command = drawing ? "L" : "M";
        drawing = true;
        return command + x(i).toFixed(1) + "," + y(point[key]).toFixed(1);
      }).join("");
      return '<path class="wm-' + key + '-line" d="' + path + '"/>';
    }
    const candles = points.map(({ open, high, low, close }, i) => {
      const xx = x(i);
      const bodyTop = y(Math.max(open, close));
      const bodyHeight = Math.max(1, y(Math.min(open, close)) - bodyTop);
      const direction = close >= open ? "wm-up" : "wm-down";
      return `<g class="${direction}">
        <line class="wm-wick" x1="${xx}" x2="${xx}" y1="${y(high)}" y2="${y(low)}"/>
        <rect class="wm-body" x="${xx - bodyWidth / 2}" y="${bodyTop}" width="${bodyWidth}" height="${bodyHeight}"/>
      </g>`;
    }).join("");
    let highIndex = 0;
    let lowIndex = 0;
    points.forEach((point, i) => {
      if (point.high > points[highIndex].high) highIndex = i;
      if (point.low < points[lowIndex].low) lowIndex = i;
    });
    function extremeLabel(key, index, offset) {
      const value = points[index][key];
      const label = number.format(value);
      const xx = x(index);
      const halfLabelWidth = label.length * 4;
      const anchor = xx - left < halfLabelWidth ? "start" : right - xx < halfLabelWidth ? "end" : "middle";
      return '<text class="wm-extreme wm-' + key + '" x="' + xx + '" y="' + (y(value) + offset) +
        '" text-anchor="' + anchor + '">' + label + '</text>';
    }
    const svg = state.svg;
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("height", height);
    svg.innerHTML = grid + dates + candles + line("ma20") + line("ma60") +
      '<line class="wm-cursor" y1="' + top + '" y2="' + bottom + '"/>' +
      '<line class="wm-cursor wm-price-line" x1="' + left + '" x2="' + right + '"/>' +
      extremeLabel("high", highIndex, -5) + extremeLabel("low", lowIndex, 14) +
      '<text class="wm-price"></text>';
    const cursor = svg.querySelector(".wm-cursor");
    const priceLine = svg.querySelector(".wm-price-line");
    const priceLabel = svg.querySelector(".wm-price");

    function show(index) {
      state.index = Math.max(0, Math.min(points.length - 1, index));
      const point = points[state.index];
      const xx = x(state.index);
      cursor.setAttribute("x1", xx);
      cursor.setAttribute("x2", xx);
      // 收盤價標在 K 棒旁邊，並拉一條水平線對照頸線；靠右邊時標在左側
      const yy = y(point.close);
      priceLine.setAttribute("y1", yy);
      priceLine.setAttribute("y2", yy);
      const onLeft = right - xx < 70;
      priceLabel.setAttribute("x", onLeft ? xx - bodyWidth / 2 - 4 : xx + bodyWidth / 2 + 4);
      priceLabel.setAttribute("y", yy + 4);
      priceLabel.setAttribute("text-anchor", onLeft ? "end" : "start");
      priceLabel.setAttribute("class", "wm-price " + (point.close >= point.open ? "wm-up" : "wm-down"));
      priceLabel.textContent = number.format(point.close);
      state.readout.textContent = point.date + "　開 " + number.format(point.open) +
        "　高 " + number.format(point.high) + "　低 " + number.format(point.low) +
        "　收 " + number.format(point.close) +
        "　當日漲跌幅 " + (point.pct == null ? "資料暫缺" : signed(point.pct));
      // 均線跟著查價線：顯示這根 K 棒當天的 MA20／MA60，箭頭是跟前一根比
      const prior = points[state.index - 1];
      state.legend.innerHTML = [20, 60].map((days) => {
        const key = "ma" + days;
        const value = point[key];
        const before = prior?.[key];
        const direction = value == null || before == null ? "" : value > before ? " ▲" : value < before ? " ▼" : "";
        return '<span class="wm-' + key + '">MA' + days + ' ' + (value == null ? "資料暫缺" : number.format(value) + direction) + '</span>';
      }).join("");
    }

    function track(event) {
      const bounds = svg.getBoundingClientRect();
      const px = (event.clientX - bounds.left) * width / bounds.width;
      show(Math.floor((px - left) / slot));
    }

    svg.onpointerdown = track;
    svg.onpointermove = track;
    svg.onpointerleave = (event) => {
      if (event.pointerType === "mouse") show(points.length - 1);
    };
    svg.onkeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Home") show(0);
      else if (event.key === "End") show(points.length - 1);
      else show(state.index + (event.key === "ArrowRight" ? 1 : -1));
    };
    show(state.index);
  }

  const observer = new ResizeObserver((entries) => entries.forEach(({ target }) => plot(target)));

  function render(target, series) {
    const candles = series?.filter(({ open, high, low, close }) =>
      [open, high, low, close].every(Number.isFinite));
    const last = candles?.at(-1);
    if (last?.ma60 == null) {
      target.innerHTML = "<p>資料暫缺</p>";
      return;
    }

    const distance = (last.close - last.ma60) / last.ma60 * 100;
    const trend = distance > 0 ? "above" : distance < 0 ? "below" : "flat";
    const label = distance > 0 ? "多頭（收盤在 60 日線上方）" :
      distance < 0 ? "空頭（收盤在 60 日線下方）" : "收盤與 60 日線持平";
    target.innerHTML = '<p class="wm-status" data-trend="' + trend + '">' + label +
      '　距 60 日線 ' + signed(distance) + '</p><p class="wm-readout"></p><p class="wm-legend"></p>' +
      '<svg tabindex="0" role="group" aria-label="日 K 走勢，可用左右方向鍵查看每日開高低收與漲跌幅"></svg>';
    const cutoff = oneYearAgo(last.date);
    const points = candles.filter((point) => point.date >= cutoff);
    charts.set(target, {
      points,
      index: points.length - 1,
      svg: target.querySelector("svg"),
      readout: target.querySelector(".wm-readout"),
      legend: target.querySelector(".wm-legend"),
    });
    plot(target);
    observer.observe(target);
  }

  worldDetails.addEventListener("toggle", async () => {
    if (!worldDetails.open || loading || loaded) return;
    loading = true;
    loadStatus.textContent = "正在載入各國股市日線…";
    try {
      const response = await fetch("./world-markets-latest.json");
      if (!response.ok) throw new Error(response.status);
      const { series } = await response.json();
      worldDetails.querySelectorAll(".wm-chart").forEach((target) => render(target, series[target.dataset.symbol]));
      loadStatus.textContent = "";
      loaded = true;
    } catch {
      loadStatus.textContent = "各國股市日線資料暫缺，可收合後重新展開。";
    } finally {
      loading = false;
    }
  });
})();
