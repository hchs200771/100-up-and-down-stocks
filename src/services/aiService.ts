import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL_NAME = 'gemini-3.1-pro-preview';

export interface Stock {
  code: string;
  name: string;
  pct: number;
  close: number;
  amount: string;
  futures?: {
    level: string;
    margin: string;
  };
}

export interface CategoryGroup {
  category: string;
  stocks: string[];
  story?: string;
}

function formatBillions(rawAmount: string) {
  if (!rawAmount) return "0";
  const num = parseFloat(rawAmount);
  if (isNaN(num)) return "0";
  return (num / 100000000).toFixed(1) + "億";
}

export async function classifyStocks(stocks: Stock[], type: '強勢股' | '弱勢股'): Promise<CategoryGroup[]> {
  const buildStockString = (s: Stock) => {
    const money = formatBillions(s.amount);
    return `${s.name}(${s.code})[成交${money}]`;
  };

  const stocksStr = stocks.map(buildStockString).join(", ");

  const strictPrompt = `
  【極重要指令：資金權重與細分】
  1. **💰 關注資金權重 (Turnover Weighted)**：
     輸入格式為 \`股票名稱(代號)[成交金額]\`。
     請高度關注 \`[ ]\` 內的成交金額。**成交金額 > 10億 的股票代表市場共識，必須優先列出並詳細分類。**
     成交金額 < 1億 的小型股若無顯著族群性可忽略。

  2. **拒絕大雜燴**：
     請盡全力挖掘股票的細分產業，使用最新的概念股來分類（例如：不要只寫「電子」，要細分出「CPO光通訊」、「CoWoS設備」、「散熱」、「特化」、「IP矽智財」、「車用二極體」。）
     舉例：昇達科放在「低軌衛星」比放在「網通與微波通訊」更適合。

  3. **微型聚落**：
     即使該族群只有 2 檔股票（例如只有兩檔光學股），也要獨立成一個分類，不要丟進其他。

  4. **強制格式**：
     回傳 JSON 時，stocks 陣列請務必還原為 \`股票名稱(四碼代號)\` 的格式 (請移除成交金額標記，保持乾淨)。

  5. **負面範例**：禁止將「電源管理IC」與「驅動IC」混為一談。
  `;

  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: `${strictPrompt} 請分析以下【${type}】：${stocksStr}。`,
    config: {
      temperature: 0.1,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            category: {
              type: Type.STRING,
              description: "細分產業分類名稱"
            },
            stocks: {
              type: Type.ARRAY,
              items: {
                type: Type.STRING
              },
              description: "股票名稱(四碼代號)"
            }
          },
          required: ["category", "stocks"]
        }
      }
    }
  });

  if (response.text) {
    try {
      return JSON.parse(response.text);
    } catch (e) {
      console.error("Failed to parse JSON", e);
      return [];
    }
  }
  return [];
}

export async function fetchCategoryStory(category: string, stocks: string[], type: '上漲' | '下跌'): Promise<string> {
  const prompt = `
  台股今日「${category}」族群表現${type === '上漲' ? '強勢' : '弱勢'}，包含以下股票：${stocks.join(', ')}。
  請使用 Google 搜尋最近3天的新聞與產業動態，總結這個族群今日${type}的主要原因與產業故事（約 100 字以內）。
  如果沒有明顯的新聞，請根據產業基本面給出可能的${type}邏輯。
  另外，開頭不需要再重複加上「台股今日xxx族群表現 ooo」或「xxxx族群今日表現強(弱)勢」，直接從頭就講產業故事。
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: {
      temperature: 0.3,
      tools: [{ googleSearch: {} }]
    }
  });

  return response.text || "無法取得產業故事。";
}

export async function generateSummary(
  gainers: CategoryGroup[], 
  losers: CategoryGroup[],
  history: { date: string, summary: string }[] = []
): Promise<string> {
  const summarizeGroups = (groups: CategoryGroup[]) => groups.map(g => `[${g.category}]: ${g.stocks.length}檔`).join(", ");
  
  const gainerSummary = summarizeGroups(gainers);
  const loserSummary = summarizeGroups(losers);

  let historyPrompt = '';
  if (history.length > 0) {
    if (history[1]) {
      historyPrompt += `【前二日盤後總結 (${history[1].date})】：\n${history[1].summary}\n`;
    }
    if (history[0]) {
      historyPrompt += `【前一日盤後總結 (${history[0].date})】：\n${history[0].summary}\n`;
    }
  }

  const prompt = `
  你是一個資深台股操盤手。請根據今日的「產業板塊資金流向」、今日台美股新聞，以及前兩日的盤後總結，寫一份 250 字內的盤後總結。
  
  ${historyPrompt}
  【今日資金熱點 (強勢)】：${gainerSummary}
  【今日資金撤離 (弱勢)】：${loserSummary}
  
  觀察重點：
  1. 資金是否有明顯的族群性？
  2. 資金流向如何？請特別對比前兩日的資金動向，分析資金是「延續原趨勢」、「一日行情」還是「出現反轉」？
  3. 輸出分析，語氣專業且犀利。
  4. 建議的資金比例與策略，不要太激進。
  `;

  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: prompt,
    config: {
      temperature: 0.5
    }
  });

  return response.text || "無法生成總結。";
}
