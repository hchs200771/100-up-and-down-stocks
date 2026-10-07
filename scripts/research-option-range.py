#!/usr/bin/env python3
"""Weekday-matched straddles and pre-expiry maximum-OI range research.

Standard library only. All predictions use prior-session public information.
This produces research artifacts; it never changes the production strategy.
"""
import argparse
import collections
import datetime as dt
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import random
import statistics as st

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data/backtest/option-range"
FAMILY = 14  # six high/low risk labels + eight paired OI/control range labels
SIGNALS = ("mean_high", "mean_low")
RISK_OUTCOMES = ("big1", "big3", "big5")
RANGE_OUTCOMES = ("whole_inside", "close_inside", "settlement_inside", "majority_inside")


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


common = load_module("straddle", ROOT / "scripts/research-weekly-straddle.py")
oi_parser = load_module("option_oi", ROOT / "scripts/lib/option_oi.py")


def mean(xs):
    return st.mean(xs) if xs else None


def add_weekday_history(rows, prices, separate_monthly=False):
    """Only prior observations with the SAME weekday and exact calendar DTE.

    Compare premium/index, so rising index levels cannot inflate the signal.
    The literal raw-point mean ratio is retained to expose that difference.
    """
    history = collections.defaultdict(list)
    dates = sorted(prices)
    indices = {day: i for i, day in enumerate(dates)}
    output = []
    for source in rows:
        row = dict(source)
        weekday = dt.date.fromisoformat(row["date"]).weekday()
        key = (weekday, row["dte"])
        if separate_monthly:
            key += ("monthly" if "W" not in row["contract"] else "weekly",)
        prior = history[key][-52:]
        normalized = row["premium"] / prices[row["date"]]["close"]
        if len(prior) >= 26:
            values = [p["normalized"] for p in prior]
            row["weekday"] = weekday
            row["history_count"] = len(prior)
            row["history_last_date"] = prior[-1]["date"]
            row["mean_ratio"] = normalized / st.mean(values)
            row["median_ratio"] = normalized / st.median(values)
            row["raw_mean_ratio"] = row["premium"] / st.mean(p["premium"] for p in prior)
            row["z_same_day"] = (normalized-st.mean(values))/st.pstdev(values) if st.pstdev(values) else None
            row["mean_high"] = row["mean_ratio"] >= 1.5
            row["mean_low"] = row["mean_ratio"] <= 2/3
            row["percentile_high"] = normalized >= common.percentile(values, .9)
            row["percentile_low"] = normalized <= common.percentile(values, .1)
            row["risk_bucket"] = "high10" if row["percentile_high"] else "low10" if row["percentile_low"] else "middle80"
            row["prior_week_change"] = normalized / prior[-1]["normalized"] - 1
            row["prior_gap_days"] = (dt.date.fromisoformat(row["date"])-dt.date.fromisoformat(prior[-1]["date"])).days
            row["jump_eligible"] = row["prior_gap_days"] == 7
            row["weekday_jump"] = row["jump_eligible"] and row["prior_week_change"] >= .25
            row["low_then_jump"] = row["weekday_jump"] and prior[-1].get("classified_low",False)
            i = indices[row["date"]]
            if i+5 < len(dates):
                close = prices[row["date"]]["close"]
                future = dates[i+1:i+6]
                excursion = max(max(abs(prices[d]["max"]/close-1), abs(prices[d]["min"]/close-1)) for d in future)
                row["big5"] = float(excursion >= .03)
                row["future_excursion5"] = excursion
                row["future_rv5"] = math.sqrt(st.mean(math.log(prices[dates[j]]["close"]/prices[dates[j-1]]["close"])**2 for j in range(i+1,i+6)))
                output.append(row)
        # Append AFTER classifying the current observation: no look-ahead.
        history[key].append({"date": row["date"], "premium": row["premium"], "normalized": normalized,
                             "classified_low":row.get("mean_low",False)})
    return output


def set_risk_strata(rows):
    train = [r for r in rows if r["date"] < "2023-01-01"]
    cuts = {key: common.percentile([r[key] for r in train], .5)
            for key in ("rv20", "today_abs", "same_day_range")}
    for row in rows:
        row["stratum"] = (row["weekday"], row["dte"], *[int(row[key] > cut) for key,cut in cuts.items()])
    return cuts


def matched_risk(rows, signal, outcome):
    groups = collections.defaultdict(lambda: [[], []])
    for row in rows:
        groups[tuple(row["stratum"])][int(row[signal])].append(row[outcome])
    differences, controls = [], []
    for non_events, events in groups.values():
        if len(non_events) >= 5:
            baseline = st.mean(non_events)
            differences.extend(x-baseline for x in events)
            controls.extend([baseline]*len(events))
    return {"difference": mean(differences), "matched_events": len(differences), "matched_control_mean": mean(controls)}


def summarize_risk(rows, signal):
    yes = [r for r in rows if r[signal]]
    no = [r for r in rows if not r[signal]]
    output = {"eligible": len(rows), "events": len(yes)}
    for outcome in (*RISK_OUTCOMES, "future_rv3", "future_rv5"):
        output[outcome] = {"event": mean([r[outcome] for r in yes]),
                           "control": mean([r[outcome] for r in no]),
                           **matched_risk(rows,signal,outcome)}
    return output


def intervals(xs, reason=None):
    if reason:
        return {"ci95": [None,None], "familywise_ci": [None,None], "reason": reason}
    return {"ci95": [common.percentile(xs,.025), common.percentile(xs,.975)],
            "familywise_ci": [common.percentile(xs,.05/(2*FAMILY)), common.percentile(xs,1-.05/(2*FAMILY))]}


def risk_bootstrap(rows, draws, block=10):
    keys = [(signal,outcome) for signal in SIGNALS for outcome in RISK_OUTCOMES]
    active = {key: [] for key in keys if matched_risk(rows,*key)["matched_events"] >= 20}
    rng = random.Random(20261006)
    for _ in range(draws):
        sample = []
        while len(sample)<len(rows):
            start=rng.randrange(len(rows))
            sample.extend(rows[(start+j)%len(rows)] for j in range(block))
        sample=sample[:len(rows)]
        for key, values in active.items():
            value = matched_risk(sample,*key)["difference"]
            if value is not None:
                values.append(value)
    return {f"{s}:{o}": intervals(active[(s,o)]) if (s,o) in active
            else intervals([], "fewer than 20 matched event dates") for s,o in keys}


def oi_walls(records, spot, otm=False):
    complete = [r for r in records if all(r.get(key) is not None and r[key] >= 0 for key in ("call_oi","put_oi"))]
    calls = [r for r in complete if r["call_oi"]>0 and (not otm or r["strike"]>=spot)]
    puts = [r for r in complete if r["put_oi"]>0 and (not otm or r["strike"]<=spot)]
    if not calls or not puts:
        return None
    call_max=max(r["call_oi"] for r in calls)
    put_max=max(r["put_oi"] for r in puts)
    call_ties=[r["strike"] for r in calls if r["call_oi"]==call_max]
    put_ties=[r["strike"] for r in puts if r["put_oi"]==put_max]
    # Keep roles. An inverted interval is NOT silently sorted into a good band.
    upper=min(call_ties,key=lambda k:(abs(k-spot),k))
    lower=min(put_ties,key=lambda k:(abs(k-spot),k))
    return {"lower":lower,"upper":upper,"call_ties":call_ties,"put_ties":put_ties,
            "call_oi":call_max,"put_oi":put_max,
            "call_concentration":call_max/sum(r["call_oi"] for r in complete),
            "put_concentration":put_max/sum(r["put_oi"] for r in complete),
            "valid":lower<upper}


def band_outcomes(lower, upper, daily, settlement, points=None):
    result={"whole_inside":float(daily["min"]>=lower and daily["max"]<=upper),
            "close_inside":float(lower<=daily["close"]<=upper),
            "settlement_inside":float(lower<=settlement<=upper),
            "open_inside":float(lower<=daily["open"]<=upper),
            "upper_breached":float(daily["max"]>upper),"lower_breached":float(daily["min"]<lower),
            "open_above":daily["open"]>upper,"open_below":daily["open"]<lower}
    if points:
        result["inside_fraction"]=st.mean(float(lower<=value<=upper) for clock,value in points)
        result["majority_inside"]=float(result["inside_fraction"]>.5)
        result["eighty_percent_inside"]=float(result["inside_fraction"]>=.8)
        result["any_breach_reentry"]=any(lower<=v<=upper for _,v in points[1:]) if not result["open_inside"] else None
        # Sequence-sensitive late return: start inside -> leave -> finish inside.
        result["intraday_breach_then_close_inside"]=bool(result["open_inside"] and
            any(v<lower or v>upper for _,v in points[1:]) and result["close_inside"])
    else:
        result["inside_fraction"]=None
        result["majority_inside"]=None
        result["eighty_percent_inside"]=None
        result["any_breach_reentry"]=(daily["min"]<=upper if result["open_above"] else daily["max"]>=lower if result["open_below"] else None)
    if result["open_above"] or result["open_below"]:
        sign=-1 if result["open_above"] else 1
        result["fade_open_close_return"]=sign*(daily["close"]/daily["open"]-1)
        result["fade_adverse_excursion"]=(daily["max"]/daily["open"]-1 if sign==-1 else 1-daily["min"]/daily["open"])
    return result


def oi_observations(records, settlements, prices, risk_rows):
    grouped=collections.defaultdict(list)
    for record in records:
        if record["date"]<record["expiry"]:
            grouped[(record["date"],record["contract"],record["expiry"])].append(record)
    risk_by_date={r["date"]:r for r in risk_rows}
    chain_by_date={}
    for year in range(2019,2026):
        chain_by_date.update(json.loads((common.CACHE/f"{year}-atm.json").read_text())["chains"])
    output, audit = [], {"non_tuesday_wednesday":0,"invalid_global":0,"invalid_otm":0,"missing_settlement":0}
    for (date,contract,expiry), group in sorted(grouped.items()):
        if dt.date.fromisoformat(date).weekday()!=1 or dt.date.fromisoformat(expiry).weekday()!=2 or (dt.date.fromisoformat(expiry)-dt.date.fromisoformat(date)).days!=1:
            audit["non_tuesday_wednesday"]+=1
            continue
        entry=settlements.get(contract)
        if not entry or entry["date"]!=expiry or expiry not in prices:
            audit["missing_settlement"]+=1
            continue
        spot=prices[date]["close"]
        point_file=CACHE/"intraday"/f"{expiry}-quotes.json"
        points=json.loads(point_file.read_text())["points"] if point_file.exists() else None
        if points:
            observed_settlement=st.mean(v for clock,v in points if "13:00:00"<clock<="13:25:00" or clock=="13:30:00")
            # TAIFEX rounds the 301-quote average to the nearest index point.
            if abs(entry["value"]-math.floor(observed_settlement+.5))>.01:
                raise ValueError(f"{expiry}: official settlement disagrees with 301-quote mean")
        atm=[r for r in chain_by_date.get(date,[]) if r["contract"]==contract]
        premium=atm[0]["premium"] if atm else None
        row={"date":date,"expiry":expiry,"contract":contract,"type":"weekly" if "W" in contract else "monthly",
             "spot":spot,"settlement":entry["value"],"daily":prices[expiry],"premium":premium,
             "risk_bucket":risk_by_date.get(date,{}).get("risk_bucket","unavailable"),
             "gap":prices[expiry]["open"]/spot-1,"has_intraday":points is not None}
        for mode in ("global","otm"):
            walls=oi_walls(group,spot,otm=mode=="otm")
            if not walls or not walls["valid"]:
                audit[f"invalid_{mode}"]+=1
                row[mode]={"walls":walls,"outcomes":None}
                continue
            lower,upper=walls["lower"],walls["upper"]
            width=upper-lower
            controls={"same_width":(spot-width/2,spot+width/2),"one_percent":(spot*.99,spot*1.01)}
            if premium:
                controls["straddle"]=(spot-premium,spot+premium)
            row[mode]={"walls":walls,"width_pct":width/spot,"width_to_straddle":width/premium if premium else None,
                       "tuesday_inside":lower<=spot<=upper,
                       "outcomes":band_outcomes(lower,upper,prices[expiry],entry["value"],points),
                       "controls":{name:band_outcomes(lo,hi,prices[expiry],entry["value"],points) for name,(lo,hi) in controls.items()}}
        output.append(row)
    return output,audit


def summarize_oi(rows,mode):
    eligible=[r for r in rows if r[mode]["outcomes"]]
    result={"total":len(rows),"valid":len(eligible),"tuesday_inside":sum(r[mode]["tuesday_inside"] for r in eligible),
            "median_width_pct":common.percentile([r[mode]["width_pct"] for r in eligible],.5),
            "median_width_to_straddle":common.percentile([r[mode]["width_to_straddle"] for r in eligible if r[mode]["width_to_straddle"] is not None],.5),
            "tied_maxima":sum(len(r[mode]["walls"]["call_ties"])>1 or len(r[mode]["walls"]["put_ties"])>1 for r in eligible)}
    for outcome in (*RANGE_OUTCOMES,"inside_fraction","eighty_percent_inside","upper_breached","lower_breached"):
        available=[r for r in eligible if r[mode]["outcomes"].get(outcome) is not None]
        result[outcome]={"n":len(available),"oi":mean([r[mode]["outcomes"][outcome] for r in available]),"controls":{}}
        for control in ("same_width","one_percent","straddle"):
            paired=[r for r in available if control in r[mode]["controls"]]
            result[outcome]["controls"][control]={"n":len(paired),"mean":mean([r[mode]["controls"][control][outcome] for r in paired]),
                    "paired_difference":mean([r[mode]["outcomes"][outcome]-r[mode]["controls"][control][outcome] for r in paired])}
    return result


def oi_bootstrap(rows,draws):
    rng=random.Random(20261007)
    result={}
    for mode in ("global","otm"):
        for outcome in RANGE_OUTCOMES:
            pairs=[(r[mode]["outcomes"][outcome]-r[mode]["controls"]["same_width"][outcome])
                   for r in rows if r[mode]["outcomes"] and r[mode]["outcomes"].get(outcome) is not None]
            values=[]
            if len(pairs)>=20:
                for _ in range(draws):
                    sampled=[]
                    while len(sampled)<len(pairs):
                        start=rng.randrange(len(pairs))
                        sampled.extend(pairs[(start+j)%len(pairs)] for j in range(4))
                    values.append(st.mean(sampled[:len(pairs)]))
            result[f"{mode}:{outcome}"]={"n":len(pairs),"difference":mean(pairs),
                        **intervals(values, "fewer than 20 paired expiry dates" if len(pairs)<20 else None)}
    return result


def gap_summary(rows,mode,control=None):
    result={}
    for side in ("above","below"):
        selected=[]
        for r in rows:
            if not r[mode]["outcomes"]:
                continue
            outcomes=r[mode]["outcomes"] if control is None else r[mode]["controls"].get(control)
            # A NEW open breakout: prior close must have been inside the band.
            prior_inside=r[mode]["tuesday_inside"] if control is None else True
            if outcomes and prior_inside and outcomes[f"open_{side}"]:
                selected.append(outcomes)
        result[side]={"n":len(selected),"touch_reentry":mean([float(x["any_breach_reentry"]) for x in selected]),
                      "close_inside":mean([x["close_inside"] for x in selected]),
                      "settlement_inside":mean([x["settlement_inside"] for x in selected]),
                      "fade_win_rate":mean([float(x["fade_open_close_return"]>0) for x in selected]),
                      "fade_mean_return":mean([x["fade_open_close_return"] for x in selected]),
                      "fade_median_adverse":common.percentile([x["fade_adverse_excursion"] for x in selected],.5)}
    return result


def fmt(x,scale=100):
    return "—" if x is None else f"{x*scale:.2f}"


def render(results):
    lines=["# 同星期價平合與最大未平倉區間驗證","",
           "由 `scripts/research-option-range.py` 產生；完整逐日觀察與稽核保存在本地研究快取。", "",
           "## 規則與時間", "", "- 價平合：C＋P先除以指數水準；與先前52筆『同星期＋同剩餘日曆天數』觀察相比，至少26筆暖機。平均比≥1.5為高，≤2/3為低；90/10百分位作敏感度。沒有把當天加入歷史平均。",
           "- OI下界＝賣權最大未平倉履約價，上界＝買權最大未平倉履約價；分別測全履約價與僅價外兩種版本。同最大值以距週二收盤最近者、再以較低履約價打破平手。",
           "- 只用當次到期契約的週二一般盤OI（週二晚上可知），預測週三。夜盤不另揭露OI，不以週三OI倒推。第三週月選與其餘週選分開呈現。",
           "- 下界≥上界的區間不排序、不強行改為有效；只保留正常週二→週三，假日順延另計排除數。",
           "- 2019–2022為開發描述與分層界線；2023–2025固定規則時間驗證。這仍是回溯研究。",
           "- 六個高低價格比較＋八個OI/等寬區間比較，共14個主要比較；區塊bootstrap同時區間按14比較Bonferroni調整。其他切片為探索性描述。", ""]
    for period,table in results["risk"]["periods"].items():
        lines.extend([f"## 同星期價平合：{period}","","|規則|訊號/有效日|次日≥1%：訊號/其他|三日≥2%：訊號/其他|五日≥3%：訊號/其他|","|---|---:|---:|---:|---:|"])
        for signal,row in table.items():
            cells=[f"{fmt(row[o]['event'])}% / {fmt(row[o]['control'])}%" for o in RISK_OUTCOMES]
            lines.append(f"|{signal}|{row['events']}/{row['eligible']}|"+"|".join(cells)+"|")
        lines.append("")
    lines.extend(["## 價平合控制後增量（2023–2025）","","按同星期、同到期天數、最近20日波動、當日絕對漲跌與當日盤中振幅分層，後三者只用開發期中位數界線。每格至少5個非訊號日。","","|比較|配對訊號日|機率差(pp)|95% CI(pp)|14比較同時CI(pp)|","|---|---:|---:|---:|---:|"])
    for key,uncertainty in results["risk"]["bootstrap"].items():
        signal,outcome=key.split(":")
        row=results["risk"]["periods"]["validation"][signal][outcome]
        lines.append(f"|{key}|{row['matched_events']}|{fmt(row['difference'])}|{fmt(uncertainty['ci95'][0])}～{fmt(uncertainty['ci95'][1])}|{fmt(uncertainty['familywise_ci'][0])}～{fmt(uncertainty['familywise_ci'][1])}|")
    lines.extend(["","### 更長群聚的敏感度","","改為20觀察日區塊，以保留更長的波動群聚；訊號與分層不變。","","|比較|20日區塊95% CI(pp)|14比較同時CI(pp)|","|---|---:|---:|"])
    for key,row in results["risk"]["block20"].items():
        lines.append(f"|{key}|{fmt(row['ci95'][0])}～{fmt(row['ci95'][1])}|{fmt(row['familywise_ci'][0])}～{fmt(row['familywise_ci'][1])}|")
    lines.extend(["","### 同年度對照的敏感度","","高檔訊號集中在2024/2025，低檔集中在2023/2025；再要求對照在同年度，以減少市場階段混淆。區塊20日，仍按14個主要比較調整；匹配樣本縮小。","","|比較|配對訊號日|機率差(pp)|95% CI(pp)|14比較同時CI(pp)|","|---|---:|---:|---:|---:|"])
    for key,uncertainty in results["risk"]["same_year"]["bootstrap"].items():
        signal,outcome=key.split(":")
        row=results["risk"]["same_year"]["summary"][signal][outcome]
        lines.append(f"|{key}|{row['matched_events']}|{fmt(row['difference'])}|{fmt(uncertainty['ci95'][0])}～{fmt(uncertainty['ci95'][1])}|{fmt(uncertainty['familywise_ci'][0])}～{fmt(uncertainty['familywise_ci'][1])}|")
    lines.extend(["","## 只看週二（2023–2025）","","|規則|訊號/有效日|三日≥2%：訊號/其他|五日≥3%：訊號/其他|","|---|---:|---:|---:|"])
    for signal,row in results["risk"]["tuesday"].items():
        lines.append(f"|{signal}|{row['events']}/{row['eligible']}|{fmt(row['big3']['event'])}% / {fmt(row['big3']['control'])}%|{fmt(row['big5']['event'])}% / {fmt(row['big5']['control'])}%|")
    lines.extend(["","## 暴增與低檔轉強：探索性切片","","只比較正好相隔7日的同星期、同DTE觀察；以premium/index計算前週變化≥25%。低檔轉強另要求上週當時已被判為平均比≤2/3。此切片不給校正後顯著性結論。","","|規則|訊號/有效日|三日≥2%：訊號/其他|五日≥3%：訊號/其他|","|---|---:|---:|---:|"])
    for signal,row in results["risk"]["transitions"].items():
        lines.append(f"|{signal}|{row['events']}/{row['eligible']}|{fmt(row['big3']['event'])}% / {fmt(row['big3']['control'])}%|{fmt(row['big5']['event'])}% / {fmt(row['big5']['control'])}%|")
    lines.extend(["","## OI區間：2023–2025","","『全日守住』是當日最高和最低均在區間；『大部分時間』是每5秒指數樣本超過50%在內。09:00:00為前收盤，已排除。","","|版本/契約|有效/總期|週二已在區間內|中位區間寬度|全日守住|收盤在內|最後結算在內|大部分時間在內(樣本期)|","|---|---:|---:|---:|---:|---:|---:|---:|"])
    for name,table in results["oi"]["validation"].items():
        for mode,row in table.items():
            lines.append(f"|{mode}/{name}|{row['valid']}/{row['total']}|{row['tuesday_inside']}|{fmt(row['median_width_pct'])}%|{fmt(row['whole_inside']['oi'])}%|{fmt(row['close_inside']['oi'])}%|{fmt(row['settlement_inside']['oi'])}%|{fmt(row['majority_inside']['oi'])}% ({row['majority_inside']['n']})|")
    lines.extend(["","## 同寬、前收盤中心的配對對照","","區間很寬，本來就容易命中。以下同一天用相同寬度，僅把中心移到週二收盤；差值才是OI位置的增量。","","|比較|配對期|OI機率－等寬機率(pp)|95% CI(pp)|14比較同時CI(pp)|","|---|---:|---:|---:|---:|"])
    for key,row in results["oi"]["bootstrap"].items():
        lines.append(f"|{key}|{row['n']}|{fmt(row['difference'])}|{fmt(row['ci95'][0])}～{fmt(row['ci95'][1])}|{fmt(row['familywise_ci'][0])}～{fmt(row['familywise_ci'][1])}|")
    lines.extend(["","### 其他區間對照（探索性）","","OI位置以global版為主；固定前收盤±1%、前收盤±價平合，也列覆蓋率。寬度不同，不能直接把較高命中率當增益。","","|區間|全日守住|收盤在內|最後結算在內|大部分時間在內|","|---|---:|---:|---:|---:|"])
    baseline=results['oi']['validation']['all']['global']
    for control in ('same_width','one_percent','straddle'):
        numbers=[baseline[o]['controls'][control]['mean'] for o in RANGE_OUTCOMES]
        lines.append(f"|{control}|"+'|'.join(f'{fmt(x)}%' for x in numbers)+'|')
    lines.extend(["","## 週三開盤新突破（週二收盤原本在內）","","只有真的跨出昨日區間才列入；碰回界線、收回區間、開盤反向持有至收盤獲利是不同事情。未扣成本、未模擬停損或期貨基差。","","|版本/方向|次數|盤中碰回|收盤回區間|結算回區間|逆開盤方向收盤勝率|逆向平均報酬|逆向中位不利走勢|","|---|---:|---:|---:|---:|---:|---:|---:|"])
    for mode,table in results["oi"]["gaps"].items():
        for side,row in table.items():
            lines.append(f"|{mode}/{side}|{row['n']}|{fmt(row['touch_reentry'])}%|{fmt(row['close_inside'])}%|{fmt(row['settlement_inside'])}%|{fmt(row['fade_win_rate'])}%|{fmt(row['fade_mean_return'])}%|{fmt(row['fade_median_adverse'])}%|")
    lines.extend(["","### 全2019–2025的開盤突破（含開發樣本）","","較早年份只有日OHLC，盤中碰回以日高低判斷；只用於補充描述，不替代時間驗證。","","|方向(global)|次數|碰回界線|收盤回區間|逆向平均報酬|","|---|---:|---:|---:|---:|"])
    for side,row in results['oi']['gaps_all_years']['global'].items():
        lines.append(f"|{side}|{row['n']}|{fmt(row['touch_reentry'])}%|{fmt(row['close_inside'])}%|{fmt(row['fade_mean_return'])}%|")
    lines.extend(["","## 價平合高低與OI區間聯合切片","","使用同星期＋DTE過去52筆的90/10百分位；只作描述，不搜尋最佳門檻。","","|價格狀態|期數|OI全日守住|大部分時間在內|中位區間寬/價平合|","|---|---:|---:|---:|---:|"])
    for name,row in results["oi"]["joint"].items():
        lines.append(f"|{name}|{row['valid']}|{fmt(row['whole_inside']['oi'])}%|{fmt(row['majority_inside']['oi'])}%|{fmt(row['median_width_to_straddle'],1)}|")
    lines.extend(["","## 資料與限制","",f"- 正常週二→週三OI觀察共{results['oi']['observations']}期；稽核排除：{results['oi']['audit']}。",
           f"- 盤中資料已驗證{results['intraday']['valid']}日／預定{results['intraday']['requested']}日；日期、完整3240筆、開高低收均與日資料交叉核對，並以301筆結算窗口平均核對官方最後結算價。",
           "- OI每一口同時有買方與賣方，不能單憑口數知道大戶淨風險、裸賣或價差／避險。觀察到區間命中也不能證明大戶操控。",
           "- 只驗證加權現貨指數，不是臺指期夜盤或期貨可成交損益。現貨09:00:05的開盤指數與期貨08:45開盤不同。",
           "- 少於20個配對訊號日不給推論區間；開盤突破事件僅描述，不能用小樣本勝率聲稱可交易。",
           "- 同星期同DTE比較更公平，但仍有事件、假日與波動制度變化；原始點數均值會隨指數水準改變，不能只用點數相除。",
           "", "資料來源：[期交所行情](https://www.taifex.com.tw/cht/3/dlOptDailyMarketView)、[官方最後結算價](https://www.taifex.com.tw/cht/5/optIndxFSP)、[證交所每5秒指數](https://www.twse.com.tw/exchangeReport/MI_5MINS_INDEX?response=json&date=20240103)。", ""])
    (ROOT/"docs/option-range-results.md").write_text("\n".join(lines))


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--draws",type=int,default=5000)
    parser.add_argument("--allow-partial",action="store_true",help="preview only; label incomplete intraday coverage")
    args=parser.parse_args()
    CACHE.mkdir(parents=True,exist_ok=True)
    intraday=json.loads((CACHE/"intraday/audit.json").read_text())
    if not args.allow_partial and (intraday['stopped'] or set(intraday['requested']) != set(intraday['valid']) | set(intraday['invalid'])):
        raise ValueError("intraday fetch is incomplete; finish fetch-option-expiry-intraday.py first")
    benchmark_path=ROOT/"research/wide-market/benchmark-input.json"
    prices={r["date"]:r for r in json.loads(benchmark_path.read_text())["benchmarkTotalReturn"]["TaiwanStockPrice"]}
    base_rows=json.loads((common.CACHE/"observations.json").read_text())
    base_results=json.loads((common.CACHE/"results.json").read_text())
    if base_results['benchmark_sha256'] != hashlib.sha256(benchmark_path.read_bytes()).hexdigest():
        raise ValueError("benchmark changed; rerun research-weekly-straddle.py before this study")
    risk_rows=add_weekday_history(base_rows,prices)
    cuts=set_risk_strata(risk_rows)
    validation=[r for r in risk_rows if r["date"]>="2023-01-01"]
    risk={"cuts":cuts,"observations":len(risk_rows),
          "periods":{name:{s:summarize_risk(part,s) for s in SIGNALS} for name,part in
          (("development",[r for r in risk_rows if r["date"]<"2023-01-01"]),("validation",validation))},
          "tuesday":{s:summarize_risk([r for r in validation if r["weekday"]==1 and r["dte"]==1],s) for s in (*SIGNALS,"percentile_high","percentile_low")},
          "sensitivity":{s:summarize_risk(validation,s) for s in ("percentile_high","percentile_low")},
          "transitions":{s:summarize_risk([r for r in validation if r['jump_eligible']],s) for s in ('weekday_jump','low_then_jump')},
          "bootstrap":risk_bootstrap(validation,args.draws),
          "block20":risk_bootstrap(validation,args.draws,20),
          "years":{str(y):{s:summarize_risk([r for r in validation if r['date'][:4]==str(y)],s) for s in SIGNALS} for y in (2023,2024,2025)}}
    separate=add_weekday_history(base_rows,prices,True)
    # Apply the SAME training cuts, without refitting to alternative groups.
    for row in separate:
        row["stratum"]=(row["weekday"],row["dte"],*[int(row[key]>cut) for key,cut in cuts.items()])
    risk["separate_monthly"]={s:summarize_risk([r for r in separate if r["date"]>="2023-01-01"],s) for s in SIGNALS}
    same_year=[{**r,'stratum':(*r['stratum'],r['date'][:4])} for r in validation]
    risk['same_year']={'summary':{s:summarize_risk(same_year,s) for s in SIGNALS},'bootstrap':risk_bootstrap(same_year,args.draws,20)}
    settlement_source=json.loads((CACHE/"settlements.json").read_text())
    settlements=settlement_source["data"]
    records=[]
    source_audit={}
    for year in range(2019,2026):
        cache_path=CACHE/f"{year}-oi.json"
        if cache_path.exists():
            saved=json.loads(cache_path.read_text())
        else:
            rows,audit=oi_parser.parse_archive(common.CACHE/f"{year}.zip",prices,lambda c:settlements.get(c,{}).get("date"))
            saved={"records":rows,"audit":audit,"archive_sha256":hashlib.sha256((common.CACHE/f"{year}.zip").read_bytes()).hexdigest()}
            cache_path.write_text(json.dumps(saved))
        records.extend(saved["records"])
        source_audit[str(year)]=saved["audit"]
        print(f"OI parsed {year}: {len(saved['records'])} strike records",flush=True)
    oi_rows,audit=oi_observations(records,settlements,prices,risk_rows)
    valid_oi=[r for r in oi_rows if r["date"]>="2023-01-01"]
    oi={"observations":len(oi_rows),"audit":audit,"source_audit":source_audit,
        "development":{m:summarize_oi([r for r in oi_rows if r["date"]<"2023-01-01"],m) for m in ("global","otm")},
        "validation":{name:{m:summarize_oi(part,m) for m in ("global","otm")} for name,part in
                      (("all",valid_oi),("weekly",[r for r in valid_oi if r["type"]=="weekly"]),("monthly",[r for r in valid_oi if r["type"]=="monthly"]))},
        "bootstrap":oi_bootstrap(valid_oi,args.draws),
        "gaps":{m:gap_summary(valid_oi,m) for m in ("global","otm")},
        "gaps_all_years":{m:gap_summary(oi_rows,m) for m in ("global","otm")},
        "gap_placebo":{m:gap_summary(valid_oi,m,"same_width") for m in ("global","otm")},
        "joint":{b:summarize_oi([r for r in valid_oi if r["risk_bucket"]==b],"global") for b in ("high10","middle80","low10")},
        "years":{str(y):{m:summarize_oi([r for r in oi_rows if r["date"][:4]==str(y)],m) for m in ("global","otm")} for y in range(2019,2026)},
        "tuesday_already_inside":{m:summarize_oi([r for r in valid_oi if r[m]['outcomes'] and r[m]['tuesday_inside']],m) for m in ("global","otm")}}
    intraday=json.loads((CACHE/"intraday/audit.json").read_text())
    results={"risk":risk,"oi":oi,"draws":args.draws,"family":FAMILY,
        "benchmark_sha256":hashlib.sha256(benchmark_path.read_bytes()).hexdigest(),
        "settlement_source_sha256":settlement_source["source_sha256"],
        "intraday":{"requested":len(intraday["requested"]),"valid":len(intraday["valid"]),"invalid":intraday["invalid"],"stopped":intraday["stopped"]}}
    (CACHE/"risk-observations.json").write_text(json.dumps(risk_rows))
    (CACHE/"oi-observations.json").write_text(json.dumps(oi_rows))
    (CACHE/"results.json").write_text(json.dumps(results,indent=2))
    render(results)
    print(f"Research complete: {len(risk_rows)} matched-weekday days; {len(oi_rows)} expiry cases",flush=True)


if __name__=="__main__":
    main()
