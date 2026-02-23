import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Activity, TrendingUp, TrendingDown, RefreshCw, AlertCircle, FileText, Download } from 'lucide-react';
import { classifyStocks, generateSummary, Stock, CategoryGroup } from './services/aiService';

interface MarketData {
  gainers: Stock[];
  losers: Stock[];
  stockMap: Record<string, string>;
  timestamp: string;
}

export default function App() {
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [marketData, setMarketData] = useState<MarketData | null>(null);
  const [gainersStructure, setGainersStructure] = useState<CategoryGroup[] | null>(null);
  const [losersStructure, setLosersStructure] = useState<CategoryGroup[] | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const runAnalysis = async () => {
    setLoading(true);
    setError(null);
    setMarketData(null);
    setGainersStructure(null);
    setLosersStructure(null);
    setSummary(null);

    try {
      setPhase('Fetching Market Data...');
      const res = await fetch('/api/market-data');
      if (!res.ok) throw new Error('Failed to fetch market data');
      const data: MarketData = await res.json();
      setMarketData(data);

      setPhase('AI Classifying Gainers & Losers...');
      const [gainers, losers] = await Promise.all([
        classifyStocks(data.gainers, '強勢股'),
        classifyStocks(data.losers, '弱勢股')
      ]);
      setGainersStructure(gainers);
      setLosersStructure(losers);

      setPhase('AI Generating Market Summary...');
      const marketSummary = await generateSummary(gainers, losers);
      setSummary(marketSummary);

      setPhase('');
    } catch (err: any) {
      setError(err.message || 'An error occurred during analysis.');
    } finally {
      setLoading(false);
    }
  };

  const downloadCSV = () => {
    if (!marketData) return;
    
    const headers = ['代號', '名稱', '漲跌幅(%)', '現價', '成交金額(億)'];
    
    const formatRow = (s: Stock) => [
      s.code,
      s.name,
      (s.pct / 100).toFixed(4),
      s.close,
      (parseFloat(s.amount) / 100000000).toFixed(1)
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

  const renderCategoryList = (categories: CategoryGroup[] | null, stockMap: Record<string, string>, type: 'gainer' | 'loser') => {
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
            <div className="flex flex-wrap gap-2">
              {group.stocks.map((stockStr, sIdx) => {
                const match = stockStr.match(/\((.*?)\)/);
                let code = '';
                let pct = '';
                if (match) {
                  code = match[1];
                  pct = stockMap[code] || '';
                }
                const isPositive = pct.includes('+');
                const pctColor = isPositive ? 'text-red-600 bg-red-50' : pct.includes('-') ? 'text-green-600 bg-green-50' : 'text-gray-600 bg-gray-50';

                return (
                  <span key={sIdx} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-gray-50 border border-gray-200 text-sm">
                    <span className="font-medium text-gray-800">{stockStr.replace(/\(.*?\)/, '')}</span>
                    {code && <span className="text-xs text-gray-500 font-mono">{code}</span>}
                    {pct && (
                      <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${pctColor}`}>
                        {pct}
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
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
            className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 mb-8 flex flex-col items-center justify-center py-12"
          >
            <div className="relative w-16 h-16 mb-4">
              <div className="absolute inset-0 border-4 border-indigo-100 rounded-full"></div>
              <div className="absolute inset-0 border-4 border-indigo-600 rounded-full border-t-transparent animate-spin"></div>
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">AI 正在處理數據</h3>
            <p className="text-sm text-gray-500 font-mono">{phase}</p>
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
