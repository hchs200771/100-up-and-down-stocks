import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Activity, TrendingUp, TrendingDown, RefreshCw, AlertCircle, FileText, Download, CheckCircle2, Circle, Loader2, Mail } from 'lucide-react';
import { classifyStocks, generateSummary, fetchCategoryStory, Stock, CategoryGroup } from './services/aiService';

interface MarketData {
  gainers: Stock[];
  losers: Stock[];
  stockMap: Record<string, { pct: string, futures?: { level: string, margin: string } }>;
  timestamp: string;
}
 
export default function App() {
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

      setGainersStructure(gainersWithStories);
      setLosersStructure(losersWithStories);

      setCurrentStep(3); // 正在生成盤後總結
      const marketSummary = await generateSummary(gainersWithStories, losersWithStories);
      setSummary(marketSummary);

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

          <h3 style="color: #dc2626;">🔥 強勢焦點 (量大優先)</h3>
      `;

      gainersStructure.forEach(g => {
        html += `
          <div style="border: 1px solid #fee2e2; background-color: #fff5f5; padding: 16px; border-radius: 12px; margin-bottom: 16px;">
            <h4 style="margin-top: 0; margin-bottom: 12px; color: #111827; font-size: 16px; display: flex; align-items: center;">
              <span style="background-color: #fecaca; color: #991b1b; padding: 2px 8px; border-radius: 12px; font-size: 12px; margin-right: 8px; font-weight: normal;">${g.stocks.length}檔</span>
              ${g.category}
            </h4>
            <div style="margin-bottom: 0;">
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
          
          html += `<a href="https://tw.stock.yahoo.com/quote/${code}.TW/technical-analysis" target="_blank" style="text-decoration: none; display: inline-block; background-color: #ffffff; border: 1px solid #e5e7eb; padding: 4px 8px; border-radius: 6px; margin: 0 6px 6px 0; font-size: 14px;">
            <strong style="color: #1f2937; font-weight: 500;">${cleanName}</strong> <span style="color: #6b7280; font-size: 12px;">${code}</span> 
            <span style="color: #dc2626; font-weight: bold; margin-left: 4px;">${pct}</span>
            ${futuresHtml}
          </a>`;
        });

        html += `</div>`;

        if (g.story) {
          html += `
            <div style="background-color: transparent; padding: 12px; border-radius: 8px; border: 1px solid #fca5a5; margin-top: 12px;">
              <strong style="color: #991b1b; font-size: 13px; display: block; margin-bottom: 4px;">💡 產業故事與上漲原因：</strong>
              <p style="margin: 0; font-size: 13px; color: #374151; line-height: 1.6;">${g.story}</p>
            </div>
          `;
        }
        html += `</div>`;
      });

      html += `<h3 style="color: #16a34a; margin-top: 30px;">🧊 弱勢焦點 (量大優先)</h3>`;

      losersStructure.forEach(g => {
        html += `
          <div style="border: 1px solid #dcfce7; background-color: #f0fdf4; padding: 16px; border-radius: 12px; margin-bottom: 16px;">
            <h4 style="margin-top: 0; margin-bottom: 12px; color: #111827; font-size: 16px; display: flex; align-items: center;">
              <span style="background-color: #bbf7d0; color: #166534; padding: 2px 8px; border-radius: 12px; font-size: 12px; margin-right: 8px; font-weight: normal;">${g.stocks.length}檔</span>
              ${g.category}
            </h4>
            <div style="margin-bottom: 0;">
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
          
          html += `<a href="https://tw.stock.yahoo.com/quote/${code}.TW/technical-analysis" target="_blank" style="text-decoration: none; display: inline-block; background-color: #ffffff; border: 1px solid #e5e7eb; padding: 4px 8px; border-radius: 6px; margin: 0 6px 6px 0; font-size: 14px;">
            <strong style="color: #1f2937; font-weight: 500;">${cleanName}</strong> <span style="color: #6b7280; font-size: 12px;">${code}</span> 
            <span style="color: #16a34a; font-weight: bold; margin-left: 4px;">${pct}</span>
            ${futuresHtml}
          </a>`;
        });

        html += `</div>`;

        if (g.story) {
          html += `
            <div style="background-color: transparent; padding: 12px; border-radius: 8px; border: 1px solid #86efac; margin-top: 12px;">
              <strong style="color: #166534; font-size: 13px; display: block; margin-bottom: 4px;">💡 產業故事與下跌原因：</strong>
              <p style="margin: 0; font-size: 13px; color: #374151; line-height: 1.6;">${g.story}</p>
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
    link.setAttribute('download', `台股資金流向_${marketData.timestamp.replace(/[\/ :]/g, '')}.csv`);
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
                    <h5 className={`text-xs font-semibold mb-1 ${type === 'gainer' ? 'text-red-900' : 'text-green-900'}`}>產業故事與${type === 'gainer' ? '上漲' : '下跌'}原因</h5>
                    <p className="text-sm text-gray-800 leading-relaxed">{group.story}</p>
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
          <div className="flex items-center gap-4">
            {marketData && (
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
            <button
              onClick={runAnalysis}
              disabled={loading}
              className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
            >
              {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
              {loading ? '分析中...' : '執行盤後分析'}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
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
                    量大優先
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
                    量大優先
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
      </main>
    </div>
  );
}
