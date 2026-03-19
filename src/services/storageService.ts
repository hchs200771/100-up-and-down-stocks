export interface HistoryRecord {
  date: string;
  summary: string;
  gainers: string[];
  losers: string[];
}

const STORAGE_KEY = 'market_history_v1';

export function getHistory(): HistoryRecord[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (data) {
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Failed to parse history from localStorage', e);
  }
  return [];
}

export function saveHistory(record: HistoryRecord) {
  const history = getHistory();
  
  // 移除同一天的舊紀錄 (避免同一天多次執行產生重複資料)
  const filtered = history.filter(h => h.date !== record.date);
  
  // 將新紀錄加到最前面
  filtered.unshift(record);
  
  // 只保留最新的 5 筆紀錄
  const newHistory = filtered.slice(0, 5);
  
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newHistory));
  } catch (e) {
    console.error('Failed to save history to localStorage', e);
  }
}
