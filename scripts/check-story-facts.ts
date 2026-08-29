#!/usr/bin/env npx tsx
/**
 * 族群故事的機械事實檢查。目前只做一件事，但這件事非做不可：
 * **擋掉「還沒公布的月營收」**。
 *
 * 台灣上市櫃公司的月營收依規定在**次月 10 日前**公布。所以在 8/28 的盤後報告裡
 * 不可能存在「8 月營收」——那個月還沒過完。實際踩過的案例（2026-08-28）：
 *
 *   「京元電作為測試代工龍頭，8月營收衝破31億元，年增31.9%，
 *     連七月39.91億元年增36.75%的佳績後再創新高。」
 *
 * 七月那半句是真的（39.91 億、年增 36.75%），八月整句是編的，而且自相矛盾——
 * 31 億比 39.91 億少，不可能是「再創新高」。
 *
 * 為什麼要用程式擋而不是只改 prompt：寫故事的是 haiku，prompt 已經寫了「不要硬湊
 * 新聞」，它還是會在找不到資料時填一個看起來合理的數字。**這種錯誤讀起來完全正常**
 * （有公司、有數字、有年增率），人工很難每天逐段抓，只有機械規則擋得住。
 *
 * 處理方式是**整句刪除**並記錄，不是改寫。改寫等於再編一次；少一句話的故事，
 * 遠好過一個假的營收數字。
 */

/** 一筆被攔下的可疑敘述 */
export interface FactIssue {
  /** 故事 id（g01/l03…） */
  id: string;
  reason: string;
  sentence: string;
}

/** 中文句子切分。保留句尾標點，才能原樣重組剩下的句子。 */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[。！？；\n])/).filter((s) => s.length > 0);
}

/**
 * 某個月份的營收，在 asOf 這天公布了沒有？
 * 規則：N 月營收最晚在 (N+1) 月 10 日公布。取「asOf 之前最近的那個 N 月」來判斷，
 * 這樣跨年也對——1 月初講「12 月營收」指的是去年 12 月，要到 1/10 才公布。
 */
export function revenueMonthPublished(month: number, asOf: Date): boolean {
  const y = asOf.getFullYear();
  const m = asOf.getMonth() + 1;
  // asOf 之前最近的那個 month
  const year = month <= m ? y : y - 1;
  const deadline = new Date(year + (month === 12 ? 1 : 0), month === 12 ? 0 : month, 10);
  return deadline <= asOf;
}

/**
 * 掃一段故事，回傳「清理後的文字」與「被拿掉的句子」。
 * asOf 用交易日，不是執行當下的時鐘。
 */
export function checkStory(id: string, story: string, asOf: Date): { text: string; issues: FactIssue[] } {
  const issues: FactIssue[] = [];
  const kept: string[] = [];

  for (const sentence of splitSentences(story)) {
    let bad: string | null = null;

    // 規則 1：直接寫「8月營收」「8 月合併營收」「8月業績」
    for (const h of sentence.matchAll(/(\d{1,2})\s*月(?:份)?\s*(?:合併)?(營收|業績|營業額)/g)) {
      const month = parseInt(h[1], 10);
      if (month >= 1 && month <= 12 && !revenueMonthPublished(month, asOf)) {
        bad = `${month} 月${h[2]}在 ${asOf.toISOString().slice(0, 10)} 尚未公布（月營收次月 10 日前才公布）`;
        break;
      }
    }

    // 規則 2：沒有把「營收」兩個字接在月份後面，但實質上就是在講那個月的營收數字。
    // 例：「7月營收10.09億元年增55%，8月預計月增7%至10.8億元」——後半段是對還沒
    // 結束的月份給出具體金額，即使寫成「預計」也是憑空生成的數字。
    // 條件收窄成三個同時成立，避免誤傷「8月28日拉漲停」這種單純的日期敘述：
    //   (a) 整句有提到營收/業績  (b) 未公布月份後 15 字內出現金額或增減幅
    if (!bad && /(營收|業績|營業額)/.test(sentence)) {
      for (const h of sentence.matchAll(/(\d{1,2})\s*月(?![\d\s]*日)/g)) {
        const month = parseInt(h[1], 10);
        if (month < 1 || month > 12 || revenueMonthPublished(month, asOf)) continue;
        const tail = sentence.slice(h.index! + h[0].length, h.index! + h[0].length + 15);
        if (/(億元?|萬元|月增|年增|月減|年減|\d+(\.\d+)?%)/.test(tail)) {
          bad = `${month} 月的營收數字在 ${asOf.toISOString().slice(0, 10)} 尚未公布，這句給出了該月的具體金額或增減幅`;
          break;
        }
      }
    }
    if (bad) {
      issues.push({ id, reason: bad, sentence: sentence.trim() });
      continue; // 整句丟掉
    }
    kept.push(sentence);
  }

  return { text: kept.join("").trim(), issues };
}

/** 供 assemble-analysis 直接呼叫；回傳所有被攔下的問題供列印。 */
export function scrubStories(
  groups: { id?: string; category?: string; story?: string }[],
  tradingDate: string,
): FactIssue[] {
  const asOf = new Date(`${tradingDate}T23:59:59+08:00`);
  const all: FactIssue[] = [];
  for (const g of groups) {
    if (!g.story) continue;
    const { text, issues } = checkStory(g.id ?? g.category ?? "?", g.story, asOf);
    if (issues.length) {
      g.story = text;
      all.push(...issues);
    }
  }
  return all;
}
