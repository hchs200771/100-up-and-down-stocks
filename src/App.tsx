import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Activity, TrendingUp, TrendingDown, RefreshCw, AlertCircle, FileText, Download, CheckCircle2, Circle, Loader2, Mail, UserRound, ExternalLink, Clock3 } from 'lucide-react';
import { classifyStocks, generateSummary, fetchCategoryStory, Stock, CategoryGroup } from './services/aiService';
import { getHistory, saveHistory } from './services/storageService';

interface MarketData {
  gainers: Stock[];
  losers: Stock[];
  stockMap: Record<string, { pct: string, futures?: { level: string, margin: string } }>;
  timestamp: string;
  tradingDate: string;
}

type HoldingResearch = {
  name: string;
  company: string;
  industry: string;
  overview: string;
  sourceHref: string;
};

const holdingResearch: HoldingResearch[] = [
  {
    name: '國巨',
    company: 'YAGEO Corporation',
    industry: '被動元件',
    overview: '提供電阻、MLCC、電感與利基型被動元件，終端應用涵蓋運算與企業系統、車用、工業與通訊。產業的重點在高階產品組合、庫存循環與終端需求恢復速度。',
    sourceHref: 'https://www.yageogroup.com/',
  },
  {
    name: '聯電',
    company: 'United Microelectronics Corporation',
    industry: '晶圓代工／特殊製程',
    overview: '以成熟製程與特殊製程為主的晶圓代工廠，服務通訊、消費、工業、車用等應用。產業觀察重點為成熟製程稼動率、特殊製程滲透率與區域擴產的資本效率。',
    sourceHref: 'https://www.umc.com/en/IR/ir_overview',
  },
  {
    name: 'AXT',
    company: 'AXT, Inc.',
    industry: '化合物半導體基板',
    overview: '生產磷化銦、砷化鎵與鍺等基板，應用於資料中心光通訊、電信、雷射、感測與衛星。產業主軸是 AI 資料中心的高速光連結需求，同時受出口許可與供應鏈地緣風險影響。',
    sourceHref: 'https://investors.axt.com/Investors/Overview/',
  },
  {
    name: 'Intel',
    company: 'Intel Corporation',
    industry: '半導體設計與晶圓代工',
    overview: '產品涵蓋 PC、資料中心與 AI 運算，並發展 Intel Foundry。產業焦點是 AI 運算需求、先進製程與先進封裝競爭，以及外部代工客戶與資本支出的執行成果。',
    sourceHref: 'https://www.intc.com/news-events',
  },
  {
    name: 'Solaris Energy Infrastructure',
    company: 'Solaris Energy Infrastructure, Inc.',
    industry: '電力基礎設施與能源服務',
    overview: '提供模組化發電、配電與原料管理方案，客戶橫跨資料中心、能源與工業。產業重點是資料中心電力需求、設備交付與併購整合；景氣與專案執行對業績影響較大。',
    sourceHref: 'https://ir.solaris-energy.com/',
  },
];

function sortGroups(groups: CategoryGroup[]): CategoryGroup[] {
  const isMisc = (group: CategoryGroup) => /^其他/.test(group.category);
  return groups
    .map((group, index) => ({ group, index }))
    .sort((a, b) => Number(isMisc(a.group)) - Number(isMisc(b.group)) || b.group.stocks.length - a.group.stocks.length || a.index - b.index)
    .map(({ group }) => group);
}

export default function App() {
  const [activePage, setActivePage] = useState<'report' | 'personal'>('report');
  const [loading, setLoading] = useState(false);
  const [currentStep, setCurrentStep] = useState<number>(-1);
  const [error, setError] = useState<string | null>(null);
  const [marketData, setMarketData] = useState<MarketData | null>(null);
  const [gainersStructure, setGainersStructure] = useState<CategoryGroup[] | null>(null);
  const [losersStructure, setLosersStructure] = useState<CategoryGroup[] | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [emailStatus, setEmailStatus] = useState<'idle' | 'success' | 'error'>('idle');

  const runAnalysis = async () => {
    setLoading(true);
    setError(null);
    setMarketData(null);
    setGainersStructure(null);
    setLosersStructure(null);
    setSummary(null);

    try {
      setCurrentStep(0); // 正在抓取證交所 API
      const res = await fetch('/api/market-data');
      if (!res.ok) throw new Error('Failed to fetch market data');
      const data: MarketData = await res.json();
      setMarketData(data);

      setCurrentStep(1); // 正在分析強弱勢股
      const [gainers, losers] = await Promise.all([
        classifyStocks(data.gainers, '強勢股'),
        classifyStocks(data.losers, '弱勢股')
      ]);

      setCurrentStep(2); // 正在找產業故事
      const gainersWithStoriesPromise = Promise.all(
        gainers.map(async (g) => {
          if (g.stocks.length >= 2) {
            try {
              const story = await fetchCategoryStory(g.category, g.stocks, '上漲');
              return { ...g, story };
            } catch (e) {
              console.error(`Failed to fetch story for ${g.category}`, e);
              return g;
            }
          }
          return g;
        })
      );

      const losersWithStoriesPromise = Promise.all(
        losers.map(async (g) => {
          if (g.stocks.length >= 3) {
            try {
              const story = await fetchCategoryStory(g.category, g.stocks, '下跌');
              return { ...g, story };
            } catch (e) {
              console.error(`Failed to fetch story for ${g.category}`, e);
              return g;
            }
          }
          return g;
        })
      );

      const [gainersWithStories, losersWithStories] = await Promise.all([
        gainersWithStoriesPromise,
        losersWithStoriesPromise
      ]);

      const sortedGainers = sortGroups(gainersWithStories);
      const sortedLosers = sortGroups(losersWithStories);
      setGainersStructure(sortedGainers);
      setLosersStructure(sortedLosers);

      setCurrentStep(3); // 正在生成盤後總結
      const history = getHistory();
      const recentHistory = history.slice(0, 2); // 取前兩天
      const marketSummary = await generateSummary(sortedGainers, sortedLosers, recentHistory);
      setSummary(marketSummary);

      // 儲存交易日紀錄
      saveHistory({
        date: data.tradingDate,
        summary: marketSummary,
        gainers: sortedGainers.map(g => g.category),
        losers: sortedLosers.map(g => g.category)
      });

      setCurrentStep(-1);
    } catch (err: any) {
      setError(err.message || 'An error occurred during analysis.');
      setCurrentStep(-1);
    } finally {
      setLoading(false);
    }
  };

  const sendEmail = async () => {
    if (!marketData || !gainersStructure || !losersStructure || !summary) return;
    
    setIsSendingEmail(true);
    setEmailStatus('idle');

    try {
      let html = `
        <div style="font-family: sans-serif; max-width: 800px; margin: 0 auto; color: #333;">
          <h2 style="color: #4f46e5; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">📈 台股盤後資金流向與 AI 總結 (${marketData.timestamp})</h2>
          
          <div style="background-color: #f3f4f6; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
            <h3 style="margin-top: 0; color: #1f2937;">📝 盤後總結</h3>
            <p style="line-height: 1.6; margin-bottom: 0;">${summary.replace(/\n/g, '<br>')}</p>
          </div>

          <h3 style="color: #dc2626;">🔥 強勢焦點（族群共振：檔數多→少）</h3>
      `;

      gainersStructure.forEach(g => {
        html += `
          <div style="border: 1px solid #fee2e2; background-color: #fef2f2; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
            <h4 style="margin-top: 0; color: #991b1b; display: flex; align-items: center;">
              <span style="background-color: #fecaca; padding: 2px 8px; border-radius: 12px; font-size: 12px; margin-right: 8px;">${g.stocks.length}檔</span>
              ${g.category}
            </h4>
            <div style="margin-bottom: 10px;">
        `;
        
        g.stocks.forEach(stockStr => {
          const match = stockStr.match(/\((.*?)\)/);
          let code = '';
          let pct = '';
          let futuresInfo = null;
          if (match) {
            code = match[1];
            const stockData = marketData.stockMap[code];
            if (stockData) {
              pct = stockData.pct;
              futuresInfo = stockData.futures;
            }
          }
          
          const cleanName = stockStr.replace(/\(.*?\)/, '');
          const futuresHtml = futuresInfo ? `<span style="font-size: 10px; background-color: #e0e7ff; color: #4338ca; padding: 2px 4px; border-radius: 4px; margin-left: 4px;">期貨(${futuresInfo.margin})</span>` : '';
          
          html += `<a href="https://tw.stock.yahoo.com/quote/${code}.TW/technical-analysis" target="_blank" style="text-decoration: none; display: inline-block; background-color: white; border: 1px solid #fca5a5; padding: 4px 8px; border-radius: 6px; margin: 0 6px 6px 0; font-size: 14px;">
            <strong style="color: #1f2937;">${cleanName}</strong> <span style="color: #6b7280; font-size: 12px;">${code}</span> 
            <span style="color: #dc2626; font-weight: bold; margin-left: 4px;">${pct}</span>
            ${futuresHtml}
          </a>`;
        });

        html += `</div>`;

        if (g.story) {
          html += `
            <div style="background-color: #fef2f2; padding: 10px; border-radius: 6px; border: 1px solid #fecaca;">
              <strong style="color: #991b1b; font-size: 13px;">💡 產業故事與上漲原因：</strong>
              <p style="margin: 5px 0 0 0; font-size: 13px; color: #b91c1c; line-height: 1.5;">${g.story}</p>
            </div>
          `;
        }
        html += `</div>`;
      });

      html += `<h3 style="color: #16a34a; margin-top: 30px;">🧊 弱勢焦點（族群共振：檔數多→少）</h3>`;

      losersStructure.forEach(g => {
        html += `
          <div style="border: 1px solid #dcfce7; background-color: #f0fdf4; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
            <h4 style="margin-top: 0; color: #166534; display: flex; align-items: center;">
              <span style="background-color: #bbf7d0; padding: 2px 8px; border-radius: 12px; font-size: 12px; margin-right: 8px;">${g.stocks.length}檔</span>
              ${g.category}
            </h4>
            <div style="margin-bottom: 10px;">
        `;
        
        g.stocks.forEach(stockStr => {
          const match = stockStr.match(/\((.*?)\)/);
          let code = '';
          let pct = '';
          let futuresInfo = null;
          if (match) {
            code = match[1];
            const stockData = marketData.stockMap[code];
            if (stockData) {
              pct = stockData.pct;
              futuresInfo = stockData.futures;
            }
          }
          
          const cleanName = stockStr.replace(/\(.*?\)/, '');
          const futuresHtml = futuresInfo ? `<span style="font-size: 10px; background-color: #e0e7ff; color: #4338ca; padding: 2px 4px; border-radius: 4px; margin-left: 4px;">期貨(${futuresInfo.margin})</span>` : '';
          
          html += `<a href="https://tw.stock.yahoo.com/quote/${code}.TW/technical-analysis" target="_blank" style="text-decoration: none; display: inline-block; background-color: white; border: 1px solid #86efac; padding: 4px 8px; border-radius: 6px; margin: 0 6px 6px 0; font-size: 14px;">
            <strong style="color: #1f2937;">${cleanName}</strong> <span style="color: #6b7280; font-size: 12px;">${code}</span> 
            <span style="color: #16a34a; font-weight: bold; margin-left: 4px;">${pct}</span>
            ${futuresHtml}
          </a>`;
        });

        html += `</div>`;

        if (g.story) {
          html += `
            <div style="background-color: #f0fdf4; padding: 10px; border-radius: 6px; border: 1px solid #bbf7d0;">
              <strong style="color: #166534; font-size: 13px;">💡 產業故事與下跌原因：</strong>
              <p style="margin: 5px 0 0 0; font-size: 13px; color: #15803d; line-height: 1.5;">${g.story}</p>
            </div>
          `;
        }

        html += `</div>`;
      });

      html += `
          <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 12px;">
            Generated by AI Studio • Gemini 3.1 Pro & 2.5 Flash
          </div>
        </div>
      `;

      const GAS_URL = "https://script.google.com/macros/s/AKfycbyP_NaR1fCyH-aGw93tZd82pC_U1Er8GJMpQWg5rD3Pp5229KTrj7avOXWgokaqUKYJxw/exec";
      
      // 使用 text/plain 來避免 CORS preflight (OPTIONS) 請求被 GAS 擋下
      await fetch(GAS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8',
        },
        body: JSON.stringify({ htmlBody: html })
      });

      setEmailStatus('success');
      setTimeout(() => setEmailStatus('idle'), 3000);
    } catch (err) {
      console.error("Failed to send email", err);
      setEmailStatus('error');
      setTimeout(() => setEmailStatus('idle'), 3000);
    } finally {
      setIsSendingEmail(false);
    }
  };

  const downloadCSV = () => {
    if (!marketData) return;
    
    const headers = ['代號', '名稱', '漲跌幅(%)', '現價', '成交金額(億)', '個股期貨', '保證金級距', '保證金比例'];
    
    const formatRow = (s: Stock) => [
      s.code,
      s.name,
      (s.pct / 100).toFixed(4),
      s.close,
      (parseFloat(s.amount) / 100000000).toFixed(1),
      s.futures ? '是' : '否',
      s.futures ? s.futures.level : '',
      s.futures ? s.futures.margin : ''
    ].join(',');

    const gainersCsv = marketData.gainers.map(formatRow).join('\n');
    const losersCsv = marketData.losers.map(formatRow).join('\n');
    
    const csvContent = `\uFEFF漲幅前100\n${headers.join(',')}\n${gainersCsv}\n\n跌幅前100\n${headers.join(',')}\n${losersCsv}`;
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `台股資金流向_${marketData.tradingDate.replace(/-/g, '')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const renderCategoryList = (categories: CategoryGroup[] | null, stockMap: Record<string, { pct: string, futures?: { level: string, margin: string } }>, type: 'gainer' | 'loser') => {
    if (!categories || categories.length === 0) return <p className="text-gray-500 italic">No data available</p>;

    return (
      <div className="space-y-4">
        {categories.map((group, idx) => (
          <div key={idx} className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm">
            <h4 className="font-semibold text-gray-900 mb-2 flex items-center gap-2">
              <span className="bg-gray-100 px-2 py-1 rounded text-xs font-mono text-gray-600">
                {group.stocks.length}
              </span>
              {group.category}
            </h4>
            <div className="flex flex-wrap gap-2 mb-3">
              {group.stocks.map((stockStr, sIdx) => {
                const match = stockStr.match(/\((.*?)\)/);
                let code = '';
                let pct = '';
                let futuresInfo = null;
                if (match) {
                  code = match[1];
                  const stockData = stockMap[code];
                  if (stockData) {
                    pct = stockData.pct;
                    futuresInfo = stockData.futures;
                  }
                }
                const isPositive = pct.includes('+');
                const pctColor = isPositive ? 'text-red-600 bg-red-50' : pct.includes('-') ? 'text-green-600 bg-green-50' : 'text-gray-600 bg-gray-50';

                return (
                  <a
                    key={sIdx}
                    href={code ? `https://tw.stock.yahoo.com/quote/${code}.TW/technical-analysis` : '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-gray-50 border border-gray-200 text-sm hover:bg-indigo-50 hover:border-indigo-200 hover:shadow-sm transition-all cursor-pointer group"
                  >
                    <span className="font-medium text-gray-800 group-hover:text-indigo-700 transition-colors">{stockStr.replace(/\(.*?\)/, '')}</span>
                    {code && <span className="text-xs text-gray-500 font-mono group-hover:text-indigo-500 transition-colors">{code}</span>}
                    {pct && (
                      <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${pctColor}`}>
                        {pct}
                      </span>
                    )}
                    {futuresInfo && (
                      <span className="text-[10px] text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-100 font-medium tracking-wide">
                        期貨 ({futuresInfo.margin})
                      </span>
                    )}
                  </a>
                );
              })}
            </div>
            {group.story && (
              <div className={`mt-3 p-3 rounded-lg border ${type === 'gainer' ? 'bg-red-50/80 border-red-100' : 'bg-green-50/80 border-green-100'}`}>
                <div className="flex items-start gap-2">
                  <FileText className={`w-4 h-4 mt-0.5 shrink-0 ${type === 'gainer' ? 'text-red-600' : 'text-green-600'}`} />
                  <div>
                    <h5 className={`text-sm font-semibold mb-1 ${type === 'gainer' ? 'text-red-900' : 'text-green-900'}`}>產業故事與${type === 'gainer' ? '上漲' : '下跌'}原因</h5>
                    <p className="text-base text-gray-800 leading-relaxed">{group.story}</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-900 selection:bg-indigo-100 selection:text-indigo-900">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-indigo-600 p-2 rounded-lg">
              <Activity className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-lg tracking-tight">台股資金流向監控</h1>
              <p className="text-xs text-gray-500 font-mono">v8.0 Ultimate AI Edition</p>
            </div>
          </div>
          <nav className="flex items-center gap-1 rounded-lg bg-gray-100 p-1" aria-label="主要頁面">
            <button
              onClick={() => setActivePage('report')}
              className={`rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors ${activePage === 'report' ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
            >
              盤後報告
            </button>
            <button
              onClick={() => setActivePage('personal')}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors ${activePage === 'personal' ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
            >
              <UserRound className="h-4 w-4" />
              個人頁面
            </button>
          </nav>
          <div className="flex items-center gap-4">
            {activePage === 'report' && marketData && (
              <>
                <span className="text-sm text-gray-500 font-mono bg-gray-100 px-3 py-1 rounded-full">
                  {marketData.timestamp}
                </span>
                {summary && (
                  <button
                    onClick={sendEmail}
                    disabled={isSendingEmail}
                    className="inline-flex items-center gap-2 bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 text-indigo-700 px-3 py-2 rounded-lg font-medium transition-colors shadow-sm disabled:opacity-50"
                    title="寄送 Email 報告"
                  >
                    {isSendingEmail ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : emailStatus === 'success' ? (
                      <CheckCircle2 className="w-4 h-4 text-green-600" />
                    ) : (
                      <Mail className="w-4 h-4" />
                    )}
                    <span className="hidden sm:inline">
                      {isSendingEmail ? '寄送中...' : emailStatus === 'success' ? '已寄出' : '寄送 Email'}
                    </span>
                  </button>
                )}
                <button
                  onClick={downloadCSV}
                  className="inline-flex items-center gap-2 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-3 py-2 rounded-lg font-medium transition-colors shadow-sm"
                  title="下載 CSV"
                >
                  <Download className="w-4 h-4" />
                  <span className="hidden sm:inline">下載數據</span>
                </button>
              </>
            )}
            {activePage === 'report' && (
              <button
                onClick={runAnalysis}
                disabled={loading}
                className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
              >
                {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
                {loading ? '分析中...' : '執行盤後分析'}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activePage === 'personal' ? (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-6"
          >
            <section className="rounded-2xl border border-indigo-100 bg-white p-6 shadow-sm">
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-indigo-50 p-2 text-indigo-600">
                  <UserRound className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold text-gray-900">持股部位</h2>
                  <p className="mt-1 text-gray-600">公司與產業研究頁，不呈現成本、數量、買賣紀錄或任何個人交易計畫。</p>
                </div>
              </div>
              <div className="mt-5 flex items-center gap-2 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <Clock3 className="h-4 w-4 shrink-0" />
                最新動態只採計近 3 天公開消息；本次檢索未發現五個標的在此期間的重大公司公告，因此不以較舊消息填補。
              </div>
            </section>

            <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {holdingResearch.map((holding) => (
                <article key={holding.name} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-medium tracking-wide text-indigo-600">{holding.industry}</p>
                      <h3 className="mt-1 text-xl font-bold text-gray-900">{holding.name}</h3>
                      <p className="mt-1 text-sm text-gray-500">{holding.company}</p>
                    </div>
                    <a
                      href={holding.sourceHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-indigo-600 hover:text-indigo-800"
                    >
                      公開來源
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </div>
                  <p className="mt-4 text-sm leading-6 text-gray-700">{holding.overview}</p>
                  <div className="mt-4 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-600">
                    近 3 天動態：未發現重大公司公告
                  </div>
                </article>
              ))}
            </section>
          </motion.div>
        ) : (
          <>
        {/* Loading State */}
        {loading && (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white p-8 rounded-2xl shadow-sm border border-gray-100 mb-8 max-w-2xl mx-auto"
          >
            <h3 className="text-xl font-bold text-gray-900 mb-6 text-center">AI 正在處理數據</h3>
            <div className="space-y-4">
              {[
                '正在抓取證交所與櫃買中心 API',
                '正在分析強弱勢股 (Gemini 3.1 Pro)',
                '正在找產業故事 (Gemini 2.5 Flash)',
                '正在生成盤後總結 (Gemini 3.1 Pro)'
              ].map((stepLabel, index) => {
                const isActive = currentStep === index;
                const isPast = currentStep > index;
                return (
                  <div key={index} className={`flex items-center gap-4 p-3 rounded-lg transition-colors ${isActive ? 'bg-indigo-50 border border-indigo-100' : ''}`}>
                    {isPast ? (
                      <CheckCircle2 className="w-6 h-6 text-green-500 shrink-0" />
                    ) : isActive ? (
                      <Loader2 className="w-6 h-6 text-indigo-600 animate-spin shrink-0" />
                    ) : (
                      <Circle className="w-6 h-6 text-gray-300 shrink-0" />
                    )}
                    <span className={`font-medium ${isActive ? 'text-indigo-900' : isPast ? 'text-gray-900' : 'text-gray-400'}`}>
                      {stepLabel}
                    </span>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}

        {/* Error State */}
        {error && (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-red-50 border border-red-200 p-4 rounded-xl mb-8 flex items-start gap-3"
          >
            <AlertCircle className="w-5 h-5 text-red-600 mt-0.5" />
            <div>
              <h3 className="text-sm font-medium text-red-800">分析失敗</h3>
              <p className="text-sm text-red-600 mt-1">{error}</p>
            </div>
          </motion.div>
        )}

        {/* Results */}
        {!loading && summary && marketData && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-8"
          >
            {/* Summary Section */}
            <section className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="bg-indigo-50/50 border-b border-gray-100 px-6 py-4 flex items-center gap-2">
                <FileText className="w-5 h-5 text-indigo-600" />
                <h2 className="text-lg font-semibold text-gray-900">盤後資金總結</h2>
              </div>
              <div className="p-6">
                <p className="text-gray-700 leading-relaxed text-lg">
                  {summary}
                </p>
              </div>
            </section>

            {/* Split View: Gainers & Losers */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              {/* Gainers */}
              <section>
                <div className="flex items-center gap-2 mb-4 px-1">
                  <div className="bg-red-100 p-1.5 rounded-md">
                    <TrendingUp className="w-5 h-5 text-red-600" />
                  </div>
                  <h2 className="text-xl font-bold text-gray-900">強勢焦點</h2>
                  <span className="text-sm text-gray-500 ml-auto bg-white px-2 py-1 rounded-md border border-gray-200">
                    族群共振：檔數多→少
                  </span>
                </div>
                <div className="bg-red-50/30 p-4 rounded-2xl border border-red-100/50">
                  {renderCategoryList(gainersStructure, marketData.stockMap, 'gainer')}
                </div>
              </section>

              {/* Losers */}
              <section>
                <div className="flex items-center gap-2 mb-4 px-1">
                  <div className="bg-green-100 p-1.5 rounded-md">
                    <TrendingDown className="w-5 h-5 text-green-600" />
                  </div>
                  <h2 className="text-xl font-bold text-gray-900">弱勢焦點</h2>
                  <span className="text-sm text-gray-500 ml-auto bg-white px-2 py-1 rounded-md border border-gray-200">
                    族群共振：檔數多→少
                  </span>
                </div>
                <div className="bg-green-50/30 p-4 rounded-2xl border border-green-100/50">
                  {renderCategoryList(losersStructure, marketData.stockMap, 'loser')}
                </div>
              </section>
            </div>
            
            <div className="text-center text-xs text-gray-400 font-mono pt-8 pb-4">
              Generated by Gemini 3.1 Pro Preview • Weighted by Turnover &gt; 10億
            </div>
          </motion.div>
        )}

        {/* Empty State */}
        {!loading && !summary && !error && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="bg-gray-100 p-4 rounded-full mb-4">
              <Activity className="w-8 h-8 text-gray-400" />
            </div>
            <h2 className="text-xl font-semibold text-gray-900 mb-2">準備就緒</h2>
            <p className="text-gray-500 max-w-md">
              點擊右上角的「執行盤後分析」按鈕，系統將自動抓取今日台股盤後數據，並透過 Gemini AI 進行資金流向分類與總結。
            </p>
          </div>
        )}
          </>
        )}
      </main>
    </div>
  );
}
