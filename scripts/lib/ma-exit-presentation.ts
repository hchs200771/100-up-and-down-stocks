/** Deterministic factor-lab artifacts from the sensitivity result; no publication. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
export function writeMaExitPresentation(o: any) {
    const id = '2026-11-13-ma-exit-length', dir = `research/factor-lab/charts/${id}`;
    mkdirSync(dir, { recursive: true });
    const f = (v: number | null, d = 2) => v === null ? '—' : v.toFixed(d);
    const a = o.results.A.S0, n20 = a.validation[20], sel = o.selection.A.S0;
    const text = (x: number, y: number, s: string, attr = '') => `<text x="${x}" y="${y}" ${attr}>${s}</text>`;
    const line = (x: number, y: number, x2: number, y2: number, c = '#aaa') => `<line x1="${x}" y1="${y}" x2="${x2}" y2="${y2}" stroke="${c}"/>`;
    const svg = (title: string, body: string, h = 500) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 ${h}" font-family="system-ui,sans-serif" font-size="12" fill="#333"><rect width="960" height="${h}" fill="white"/><title>${title}</title>${text(480, 25, title, 'text-anchor="middle" font-size="18"')}${body}</svg>\n`;
    function chart(title: string, series: {
        label: string;
        color: string;
        points: {
            x: number;
            y: number;
        }[];
    }[], top = 65, height = 340) {
        const vals = series.flatMap(s => s.points.map(p => p.y)), lo = Math.min(0, ...vals), hi = Math.max(...vals) * 1.08 || 1;
        const sx = (n: number) => 85 + (n - 10) / 50 * 790, sy = (y: number) => top + height - (y - lo) / (hi - lo) * height;
        let b = text(85, top - 13, title) + line(sx(20), top, sx(20), top + height, '#c55') + text(sx(20) + 5, top + 15, 'N=20');
        for (let i = 0; i <= 5; i++) {
            const v = lo + (hi - lo) * i / 5;
            b += line(85, sy(v), 875, sy(v), '#ddd') + text(75, sy(v) + 4, f(v, 1), 'text-anchor="end"');
        }
        for (const n of o.lengths)
            b += text(sx(n), top + height + 22, String(n), 'text-anchor="middle"');
        series.forEach((s, i) => { b += text(410 + i * 210, top - 13, s.label, `fill="${s.color}"`) + `<polyline fill="none" stroke="${s.color}" stroke-width="2" points="${s.points.map(p => `${sx(p.x)},${sy(p.y)}`).join(' ')}"/>`; for (const p of s.points)
            b += `<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="3" fill="${s.color}"><title>N=${p.x}, ${f(p.y)}</title></circle>`; });
        return b;
    }
    const retSeries = ['train', 'validation'].map((p, i) => ({ label: i ? '驗證 2016–2026' : '訓練 2005–2015', color: i ? '#2679c8' : '#888', points: o.lengths.map((n: number) => ({ x: n, y: a[p][n].avgPct })) }));
    writeFileSync(`${dir}/01-mean-return.svg`, svg('A 新高突破 S0：均線長度與每筆平均淨報酬', chart('每筆報酬（%）', retSeries) + text(85, 465, '橫軸為線性 N；10、30、40、60 亦按實際長度繪製。來回成本 0.6%。')));
    const behavior = (key: string) => ['S0', 'S2'].map((m, i) => ({ label: m === 'S0' ? 'S0 無停損' : 'S2 固定 −10%', color: i ? '#d87832' : '#2679c8', points: o.lengths.map((n: number) => ({ x: n, y: o.results.A[m].validation[n][key] })) }));
    writeFileSync(`${dir}/02-wash-hold.svg`, svg('A 驗證段：均線出場被洗與持有天數（各自獨立縱軸）', chart('均線被洗率（%）', behavior('maWashRatePct'), 75, 230) + chart('平均持有日（市場交易日）', behavior('hold'), 410, 230) + text(85, 700, '被洗率分母：均線出場且有完整 20 日追蹤者；停損出場不混入。兩圖縱軸獨立。'), 735));
    {
        const cis = o.lengths.map((n: number) => a.validation[n].vs20), lo = Math.min(0, ...cis.map((c: any) => c.ci95Pp[0])) - .1, hi = Math.max(0, ...cis.map((c: any) => c.ci95Pp[1])) + .1;
        const sx = (n: number) => 85 + (n - 10) / 50 * 790, sy = (v: number) => 405 - (v - lo) / (hi - lo) * 335;
        let b = text(85, 54, '相對 N=20 每筆報酬差（百分點）；逐點 95% CI');
        for (let i = 0; i <= 5; i++) {
            const v = lo + (hi - lo) * i / 5;
            b += line(85, sy(v), 875, sy(v), '#ddd') + text(75, sy(v) + 4, f(v), 'text-anchor="end"');
        }
        b += line(85, sy(0), 875, sy(0), '#c55');
        o.lengths.forEach((n: number, i: number) => { const c = cis[i], x = sx(n), [l, h] = c.ci95Pp; b += line(x, sy(l), x, sy(h), '#2679c8') + line(x - 4, sy(l), x + 4, sy(l), '#2679c8') + line(x - 4, sy(h), x + 4, sy(h), '#2679c8') + `<circle cx="${x}" cy="${sy(c.meanDifferencePp)}" r="3" fill="#2679c8"/>` + text(x, 430, String(n), 'text-anchor="middle"'); });
        writeFileSync(`${dir}/03-paired-ci.svg`, svg('A S0 驗證段：各 N 與 20 的配對差', b + text(85, 470, '依進場月份整群重抽 2000 次；未做多重比較校正，跨月重疊交易的相關性可能未完整涵蓋。')));
    }
    const ns = o.mainGrid, range = (key: string) => { const vs = ns.map((n: number) => a.validation[n][key]); return `${f(Math.min(...vs))}～${f(Math.max(...vs))}`; };
    const s15 = a.validation[15], s25 = a.validation[25], s18 = a.validation[18], s22 = a.validation[22];
    const years = Object.entries(o.yearly.A.S0) as [
        string,
        any
    ][];
    const yearCounts = Object.entries(years.reduce((r: Record<string, number>, [, v]) => { r[v.bestN] = (r[v.bestN] ?? 0) + 1; return r; }, {})).map(([n, c]) => `${n} 日 ${c} 年`).join('、');
    const ci = (s: any) => `${f(s.vs20.meanDifferencePp)} pp，95% CI [${s.vs20.ci95Pp.map((v: number) => f(v)).join(', ')}]`;
    const selectionText = (k: string) => { const s = sel[k]; return `${k === 'allGrid' ? '全網格' : '15–25 主網格'}訓練最佳 N=${s.bestN}（${f(s.trainAvgPct)}%），驗證 ${f(s.validation.avgPct)}%、第 ${s.validationRank}/${s.candidates}，相對 20 ${ci(s.validation)}`; };
    const conclusion = '18–22 日在驗證段接近平台，沒有 20 日過度擬合的明顯證據；延長均線沒有明顯減少被洗。';
    const entry = { id, date: '2026-11-13', category: '出場規則／穩健性', title: '均線出場長度敏感度：20 日是不是過度擬合？', question: '用 20 日均線出場是不是過度擬合？改 18、22 日或其他長度會更好嗎？', verdict: '有條件', verdictNote: '比較鄰域、訓練選擇與時間穩定性；不把驗證段最佳長度升格成新規則。', summary: `**${conclusion}** A S0 驗證 N=20 每筆 ${f(n20.avgPct)}%；18 日 ${f(s18.avgPct)}%、22 日 ${f(s22.avgPct)}%，15–25 範圍 ${range('avgPct')}%。`, method: `完全沿用 volume-profile-stop 的還原日線、進場、VP 歷史資格、流動性及同日隨機 B（有放回，seed ${o.seed}）；樣本 ${o.entryPeriod.join('～')}，行情至 ${o.period[1]}。收盤進場，次日起嚴格收盤 < SMA_N 收盤出場，最長 120 市場交易日；S0 無停損、S2 固定進場價 −10% 收盤停損，停損同日優先。成本 0.6%。N=10、15–25、30、40、60 全部使用相同進場。依進場日在 2016 前後分訓練／驗證；每組、停損與期間均列配對月份 bootstrap 2000 次。N=20 逐筆精確對齊原實驗。`, stats: [{ label: 'A S0：20 日訓練／驗證', value: `${f(a.train[20].avgPct)}% / ${f(n20.avgPct)}%` }, { label: '18 − 20：驗證', value: ci(s18) }, { label: '22 − 20：驗證', value: ci(s22) }, { label: '驗證 20 日鄰域平均', value: `${f(o.neighborhoods.A.S0.validation[20].avgPct)}%`, note: '18–22 各長度平均報酬等權平均' }], findings: [`被洗率：只看均線出場，之後 20 個交易日內任一收盤比出場價漲至少 5%；完整追蹤窗口才計分母。錯過漲幅是這些被洗交易在窗口內最高收盤相對出場價的平均，不是全部出場的平均。停損被洗另以回到進場價定義，兩者不可互換。`, `平台區／鄰域平均：若相鄰長度結果接近，就不是只有某一點特別高的尖峰。N 的鄰域取 N−2～N+2 等權平均；驗證 18、20、22 分別 ${[18, 20, 22].map(n => f(o.neighborhoods.A.S0.validation[n].avgPct) + '%').join('、')}；15–25 單點 ${range('avgPct')}%。邊界及稀疏網格另標 complete=false，不當完整五點鄰域。`, `配對 bootstrap：同一筆進場把 N 與 20 的報酬相減，再把同月份交易整包重抽，估計差距可能落在哪裡；95% 區間包含 0 時，無法排除沒有差異。18 日 ${ci(s18)}；22 日 ${ci(s22)}。區間為逐點，並未校正多重比較。`, selectionText('allGrid') + '。' + selectionText('mainGrid') + '。A S2 訓練同樣選 20，驗證在主網格第 ' + o.selection.A.S2.mainGrid.validationRank + '/11；B 的 S0/S2 都選 19，主網格驗證分別第 ' + o.selection.B.S0.mainGrid.validationRank + '、' + o.selection.B.S2.mainGrid.validationRank + '/11。', `靈敏與少被洗的取捨（A S0 驗證）：15 日 ${f(s15.avgPct)}%、持有 ${f(s15.hold, 1)} 日、被洗 ${f(s15.maWashRatePct, 1)}%；25 日 ${f(s25.avgPct)}%、持有 ${f(s25.hold, 1)} 日、被洗 ${f(s25.maWashRatePct, 1)}%。對應錯過漲幅 ${f(s15.missedGainPct)}%／${f(s25.missedGainPct)}%。這批樣本並未支持「長均線較少被洗」：15 與 25 日被洗率幾乎相同。更長均線也可能讓獲利回吐或加深風險，平均報酬不代表資金曲線。`, `整體形狀（A S0）：10／30／40／60 日訓練 ${[10, 30, 40, 60].map(n => f(a.train[n].avgPct) + '%').join('／')}，驗證 ${[10, 30, 40, 60].map(n => f(a.validation[n].avgPct) + '%').join('／')}；長 N 驗證較高，但訓練反而較低，不支持跨時期唯一最優。S2 的 20 日驗證停損被洗率 ${f(o.results.A.S2.validation[20].stopWashRatePct, 1)}%，與均線被洗 ${f(o.results.A.S2.validation[20].maWashRatePct, 1)}% 分開看。`, `逐年 15–25 最佳：${yearCounts}；20 日名次範圍 ${Math.min(...years.map(([, v]) => v.rank20))}～${Math.max(...years.map(([, v]) => v.rank20))}/11，最佳 ${years.filter(([, v]) => v.bestN === 20).length}/${years.length} 年。年份歸屬按進場年，2026 非完整年度。完整 A/B × S0/S2 逐年表與主表見 results。`], caveats: ['20 日是市場慣用長度，不是在本資料上挑出來的；本實驗無法證明它是唯一最優，也不能將這次驗證最好的 N 當成全新樣本外結果。', '交易重疊，沒有資金、部位與持倉數限制；每筆平均報酬不是年化或可交易資金績效。月份分群仍可能漏掉跨月份依賴，且多 N、多組比較沒有校正。', '收盤訊號假設同收盤成交，未計滑價、跌停無法成交或委託延遲。成本固定 0.6%，不是每檔真實費率。', `承接原實驗的 VP 資格與不支援價格排除；A/B 排除 ${o.excluded.A}/${o.excluded.B} 筆，早期上櫃缺日 ${o.missingFiles.tpex}。同日隨機 B 並非產業或波動配對。`, '未知除權息事件打斷價格片段即以前一有效收盤結算；資料尾端未滿 120 日結算。均線依原實驗遇缺值重置，不另依片段重置；被洗窗口同片段且完整，缺報價不算觸發。', '訓練／驗證按進場日切分，2015 年末進場可能持有至 2016；未作 purge。2026 僅涵蓋快取截止日，沒有補假資料。'], nextIdeas: ['固定候選長度後，以新資料和次日成交假設前向追蹤；若比較風險，再另立含資金限制與回撤的實驗。'], source: { script: 'scripts/research-ma-exit-length.ts', results: 'data/backtest/ma-exit-length-results.json', doc: 'research/factor-lab/ma-exit-length-review.md' }, charts: [{ file: '01-mean-return.svg', caption: '**檢查曲線形狀及訓練／驗證是否一致**；紅線標出 20 日，橫軸按實際 N。' }, { file: '02-wash-hold.svg', caption: '**敏感度與持有時間的取捨**；被洗率與天數各有自己的縱軸。' }, { file: '03-paired-ci.svg', caption: '**同一批進場的報酬差**；區間跨 0 代表無法排除沒有差異，非所有長度等效的證明。' }] };
    const path = 'research/factor-lab/experiments.json', experiments = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify([entry, ...experiments.filter((e: any) => e.id !== id)], null, 2) + '\n');
    let md = `# 均線出場長度敏感度\n\n${entry.summary}\n\n資料至 ${o.period[1]}；每筆淨報酬已扣 0.6%。以下每格為「訓練／驗證」。被洗率僅均線出場且追蹤完整者；日為市場交易日。\n`;
    for (const g of ['A', 'B'])
        for (const m of ['S0', 'S2']) {
            const r = o.results[g][m];
            md += `\n## ${g} ${m}（訓練 ${r.train[20].n} 筆／驗證 ${r.validation[20].n} 筆）\n\n| N | 平均淨報酬 % | 均線被洗率 % | 平均持有日 |\n|---:|---:|---:|---:|\n`;
            for (const n of o.lengths)
                md += `| ${n} | ${f(r.train[n].avgPct)}／${f(r.validation[n].avgPct)} | ${f(r.train[n].maWashRatePct, 1)}／${f(r.validation[n].maWashRatePct, 1)} | ${f(r.train[n].hold, 1)}／${f(r.validation[n].hold, 1)} |\n`;
        }
    md += '\n## 驗證配對差（百分點；各 N 減 20）\n\n| N | A S0 差 [95% CI] | A S2 | B S0 | B S2 |\n|---:|---:|---:|---:|---:|\n';
    for (const n of o.lengths)
        md += `| ${n} | ${['A', 'B'].flatMap(g => methods.map(m => ci(o.results[g][m].validation[n]))).join(' | ')} |\n`;
    md += '\n## 只用訓練挑選\n\n';
    for (const g of ['A', 'B'])
        for (const m of ['S0', 'S2'])
            for (const k of ['allGrid', 'mainGrid']) {
                const s = o.selection[g][m][k];
                md += `- ${g} ${m} ${k}：N=${s.bestN}，訓練 ${f(s.trainAvgPct)}%，驗證 ${f(s.validation.avgPct)}%，第 ${s.validationRank}/${s.candidates}，${ci(s.validation)}。\n`;
            }
    md += '\n## 逐年（主網格最佳 N／20 的名次）\n\n| 年 | A S0 | A S2 | B S0 | B S2 |\n|---|---|---|---|---|\n';
    for (const [y] of years)
        md += `| ${y} | ${['A', 'B'].flatMap(g => methods.map(m => { const r = o.yearly[g][m][y]; return `${r.bestN}／${r.rank20}`; })).join(' | ')} |\n`;
    md += '\n## 解讀\n\n' + entry.findings.join('\n\n') + '\n\n## 限制\n\n' + entry.caveats.join('\n\n') + '\n';
    writeFileSync('research/factor-lab/ma-exit-length-review.md', md);
}
const methods = ['S0', 'S2'];
