import fs from 'node:fs';

const skeletonPath = 'data/tmp/analysis-skeleton.json';
const marketPath = 'data/market-latest.json';
const outputPath = 'data/analysis-latest.json';

const skeleton = JSON.parse(fs.readFileSync(skeletonPath, 'utf8'));
const marketData = JSON.parse(fs.readFileSync(marketPath, 'utf8'));

if (skeleton.date !== marketData.tradingDate) {
  throw new Error(`date mismatch: skeleton=${skeleton.date}, market=${marketData.tradingDate}`);
}

const judgments = {
  'PCB/面板製程設備': [38, 'AI擴產支撐設備需求，分批布局等訂單兌現'],
  '海外個股槓桿ETF': [0, '槓桿重設與低流動性放大風險，只宜短打'],
  'ASIC/IP矽智財': [38, 'AI客製晶片長線明確，但強弱並陳宜等回測'],
  '矽晶圓/半導體基板': [25, '報價循環改善但已偏熱，等量縮回測再看'],
  '數位內容/軟體服務與出版': [15, '題材擴散快於獲利驗證，列觀察不追價'],
  '鋼鐵/金屬材料': [20, '補庫存與報價具週期性，等待訂單確認再進'],
  '半導體封測': [38, 'AI封測瓶頸且法人承接，可建立核心底倉'],
  '面板/電子紙與顯示模組': [25, '減產有利報價止穩，但當沖偏高不追'],
  '低軌衛星/HDI高階PCB': [35, '高階板規格升級延續，回測承接可分批布局'],
  '傳統PCB/EMS板廠': [20, '偏低基期輪動且內部分化，先觀察訂單續航'],
  '零售電商/生活消費': [12, '事件與低流通籌碼主導，只作短線觀察'],
  '一般網通/企業網路設備': [38, '800G升級是主線，但族群分化先守龍頭'],
  'AI伺服器散熱/機構件': [40, '液冷升級長線明確，啟動期可小量布局'],
  'ABF/BT載板': [38, 'AI載板規格與擴產共振，啟動期可建立底倉'],
  '車用電動化/車電與AM零組件': [25, '車電趨勢仍在但籌碼過熱，等待回檔'],
  '功率元件/電源管理IC': [30, '庫存循環與電氣化支撐，啟動期可試單'],
  '半導體設備/測試介面': [38, '先進製程資本支出支撐，當沖偏高先等回測'],
  'NB機構件/轉軸與精密結構件': [28, '規格升級具中期需求，但高彈性股不追價'],
  '紡織成衣/化纖': [15, '低流通輪動色彩濃，基本面未證實前不追'],
  '電子通路/半導體代理': [15, '通路週期可回溫，但個股籌碼性高先觀察'],
  '網通通訊IC/手機SoC': [35, '規格升級兼具龍頭籌碼，啟動期可布局'],
  '生技/新藥與醫材': [20, '事件驅動且強弱分化，僅保留驗證型部位'],
  '新掛牌/特殊交易事件': [0, '新掛牌價格發現失真，不納入長線部位'],
  '綠能/太陽能與電力工程': [28, '政策長尾仍在但族群退潮，只觀察不追'],
  '車用照明/AM車體零組件': [20, 'AM需求具週期性，單一事件股僅小量觀察'],
  '電源供應器/UPS': [38, 'AI電力瓶頸為長線主題，待成員擴散確認'],
  '連接器/高速介面與線束': [35, '高速介面升級延續，但強弱並陳先守龍頭'],
  '工業電腦/系統散熱與邊緣裝置': [30, '邊緣運算需求可追蹤，單一個股先驗證'],
  '環保工程/資源循環': [25, '政策需求具長尾，仍待訂單與獲利確認'],
  '塑化/特用化學與工業材料': [20, '報價循環未穩且籌碼退潮，暫不放新錢'],
  '工業自動化/工具機設備': [25, '自動化具中期需求，但分化下只看龍頭'],
  'MCU/消費控制IC與音訊晶片': [25, '庫存循環可回升但籌碼過熱，等回測'],
  'LED/光電元件與照明模組': [20, '連強後只剩個股且法人調節，宜降溫觀察'],
  '食品餐飲/內需消費': [15, '單一低基期事件主導，不以長線邏輯追價'],
  'PCB鑽針/製程耗材': [35, '高階板耗材需求長線在，但高潮段先減碼'],
  '半導體材料/CMP與電子化學品': [38, '先進製程耗材需求明確，回測可分批承接'],
  '建材陶瓷/衛浴與營建材料': [10, '內需題材缺乏擴散，啟動期仍以觀察為主'],
  '觀光餐飲/內需消費': [15, '單一個股輪動且證據不足，不追價'],
  '其他強勢個股事件整理': [0, '個股事件無族群支撐，只宜短線交易'],
};

const actionFor = (score) => score >= 85 ? '核心加碼' : score >= 70 ? '標準持有' : score >= 55 ? '觀察不追' : '不碰減碼';

const gainers = skeleton.gainers.map((group) => {
  const judgment = judgments[group.category];
  if (!judgment) throw new Error(`missing judgment: ${group.category}`);
  const [trend, entryRationale] = judgment;
  const scoreBreakdown = { ...group.scoreBreakdown, trend };
  const entryScore = Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0);
  const result = {
    category: group.category,
    stocks: group.stocks,
    story: group.story,
    confidence: group.confidence,
  };
  if (group.stage !== undefined) result.stage = group.stage;
  return {
    ...result,
    entryScore,
    scoreBreakdown,
    entryAction: actionFor(entryScore),
    entryRationale,
  };
});

const losers = skeleton.losers.map((group) => {
  const result = {
    category: group.category,
    stocks: group.stocks,
    story: group.story,
    confidence: group.confidence,
  };
  if (group.retreatSignal !== undefined) result.retreatSignal = group.retreatSignal;
  return result;
});

const summary = '加權收47,800.17點、漲81.33點，主線延續看PCB設備、面板與網通；新主線是封測、ASIC／IP及ABF載板，散熱與電源偏補漲。ASIC、傳統PCB、網通同列強弱，屬換手分化；零售、綠能、連接器、工具機與生技則有退潮警訊。漲800家、跌1,227家、漲停24家，上市／上櫃當沖23.44%／20.43%，指數紅但廣度偏弱，持股維持六成、聚焦主線龍頭。';

const longTermStrategy = '未來1至2年只保留兩條核心研究。第一條是AI基礎建設的運算、網路、散熱與電力瓶頸：已確認雲端業者自研ASIC、800G／1.6T交換器、液冷與高功率電源帶動規格升級，創意、智原、智邦、雙鴻可作龍頭或高純度追蹤，安葆與其他單一小型股只列波段觀察。合理推論是資本支出仍會沿晶片、網路、散熱逐段外溢，但下一個驗證點必須是法說訂單、月營收與毛利率同步跟上；龍頭續強且成員擴散可續抱，現階段強弱同榜者等回測，不因一天籌碼加碼。第二條是先進封裝、高階PCB及製程耗材：AI晶片封裝面積、ABF層數與HDI規格提升，加上封測產能瓶頸，讓日月光投控、京元電子、景碩、欣興、臻鼎-KY及中砂列核心研究；設備端科嶠、牧德則等合約負債轉成營收後再提高權重。已確認的是擴產與資本支出方向，合理推論為供給建置期較長、設備與耗材仍會被反覆交易，驗證點是稼動率、報價、訂單及現金流。矽晶圓、面板屬週期波段，等報價與毛利改善；槓桿商品、新掛牌、低流通事件股及純補漲不列長線核心。若TTM營收轉負、毛利連降或稀釋風險升高就降級，族群分化僅先作預警。近期系統樣本顯示啟動族群T+5平均報酬0.34%、擴散族群為-0.79%，因此持股信心仍須由基本面驗證而非追價決定。';

const analysis = {
  timestamp: skeleton.timestamp,
  date: skeleton.date,
  gainers,
  losers,
  summary,
  longTermStrategy,
};

fs.writeFileSync(outputPath, `${JSON.stringify(analysis, null, 2)}\n`);

const representativeStocks = (stocks) => {
  const shown = stocks.slice(0, 3).join('、');
  return stocks.length > 3 ? `${shown}等` : shown;
};
const memoryLines = [
  '---',
  `date: ${skeleton.date}`,
  `timestamp: ${skeleton.timestamp}`,
  '---',
  '',
  '## 盤後總結',
  '',
  summary,
  '',
  '## 強勢族群',
  '',
  ...gainers.map((group) => `- ${group.category}: ${group.stocks.length}檔 — ${representativeStocks(group.stocks)}`),
  '',
  '## 弱勢族群',
  '',
  ...losers.map((group) => `- ${group.category}: ${group.stocks.length}檔 — ${representativeStocks(group.stocks)}`),
  '',
];
fs.writeFileSync(`data/memory/${skeleton.date}.md`, memoryLines.join('\n'));
