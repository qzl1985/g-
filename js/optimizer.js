/**
 * optimizer.js — AI 容量优化与策略寻优
 *
 * 1) optimizeCapacity：在预算/场地/负荷约束下，搜索光伏+储能(+充电桩)最优容量组合。
 *    目标可选：maxNpv（净现值最大）/ minPayback（回本最快）/ maxIrr（收益率最高）。
 *    采用"粗粒度网格搜索 + 局部细化"的启发式，兼顾速度与质量，结果可解释。
 *
 * 2) optimizeDispatch：评估不同储能调度策略（套利 / 套利+削峰 / 套利+平段充电），
 *    选出收益最高者。
 *
 * 3) sizeStorage：根据负荷曲线"反算"所需储能容量（谷充峰放、一充一放），
 *    供"AI 自动反算储能容量"使用，结果可解释、可手动微调。
 */

const Optimizer = {
  /**
   * 储能容量反算：依据代表日负荷曲线与分时时段，按"谷段充电、峰段放电、
   * 一充一放"的工程逻辑推荐储能 kWh / kW。
   * @param {object} cfg 完整配置
   * @returns { capacityKwh, powerKw, ePeak, hPeak, hValley, explain }
   */
  sizeStorage(cfg) {
    const region = REGIONS[cfg.regionKey];
    const load = cfg.load || {};
    const monthly = (load.monthly && load.monthly.length === 12) ? load.monthly : null;
    const annualKwh = monthly ? monthly.reduce((a, b) => a + (+b || 0), 0) : (load.annualKwh || 0);
    const st = cfg.storage || {};
    const dod = st.dod || 0.95;
    const eff = st.efficiency || 0.9;

    const loadDay = Engine.buildLoadDay(annualKwh / 365, load, region);

    // 按分时时段统计：峰段用电量、峰段时长、谷段时长
    let ePeak = 0, hPeak = 0, hValley = 0;
    for (let h = 0; h < 24; h++) {
      const tier = region.tou.schedule[h] || 'flat';
      if (tier === 'peak' || tier === 'sharp') { ePeak += loadDay[h]; hPeak++; }
      if (tier === 'valley') hValley++;
    }
    if (hPeak === 0 || annualKwh <= 0) {
      return { capacityKwh: 0, powerKw: 0, ePeak: 0, hPeak, hValley,
        explain: '该地区无明显高峰时段或未填用电量，储能套利空间有限，暂不建议配置。' };
    }

    // 功率：先按覆盖峰段平均负荷
    let powerKw = ePeak / hPeak;
    // 谷段可充入电量（受功率与谷段时长限制）
    const chargeable = hValley > 0 ? hValley * powerKw * Math.sqrt(eff) : powerKw * 2;
    // 可用放电量 = min(峰段负荷, 谷段可充)
    const eUse = Math.min(ePeak, chargeable);
    powerKw = Math.max(powerKw * 0.6, eUse / hPeak);

    // 额定容量（一充一放，计放电深度）
    let capacityKwh = eUse / dod;

    // —— 需量管理：必须结合变压器容量与最大需量来配储能（削峰） ——
    const pf = 0.9;                                  // 功率因数（缺省）
    const peakKw = load.peakKw || Math.round(Math.max.apply(null, loadDay) * 1.3);
    const transformerKVA = load.transformerKVA || 0;
    const txKw = transformerKVA * pf;                // 变压器可带最大有功
    let demandCut = peakKw * 0.15;                   // 默认削峰 15%
    let txNote = '';
    if (txKw > 0) {
      if (peakKw > txKw * 0.85) {
        // 需量接近变压器满载：削峰到 ~75% 容量，避免增容/超容
        demandCut = Math.max(demandCut, peakKw - txKw * 0.75);
        txNote = `；最大需量 ${Math.round(peakKw)}kW 接近变压器 ${transformerKVA}kVA(可带${Math.round(txKw)}kW)，按削峰至 75% 容量配置`;
      } else {
        txNote = `；变压器 ${transformerKVA}kVA（可带${Math.round(txKw)}kW），需量 ${Math.round(peakKw)}kW 余量充足`;
      }
    }
    const powerDemand = Math.max(0, demandCut);      // 削峰所需功率
    const capDemand = powerDemand * 2;               // 维持约 2 小时峰段
    // 取套利与削峰两者更大者，确保不忽略变压器/需量约束
    powerKw = Math.max(powerKw, powerDemand);
    capacityKwh = Math.max(capacityKwh, capDemand);

    // 取整到合理工程规格
    capacityKwh = Math.max(0, Math.round(capacityKwh / 50) * 50);
    powerKw = Math.max(0, Math.round(powerKw / 25) * 25);
    // 约束功率在 0.25C ~ 1C 之间
    powerKw = Math.min(powerKw, capacityKwh);
    powerKw = Math.max(powerKw, Math.round(capacityKwh * 0.25 / 25) * 25);
    if (capacityKwh > 0 && powerKw === 0) powerKw = 25;

    const hours = powerKw > 0 ? (capacityKwh / powerKw) : 0;
    const explain =
      `根据负荷曲线反算：高峰时段约 ${hPeak} 小时、峰段用电约 ${Math.round(ePeak).toLocaleString()} kWh，` +
      `低谷可充约 ${hValley} 小时${txNote}。\n按"谷充峰放、一充一放 + 削峰"测算，建议储能 ` +
      `${capacityKwh.toLocaleString()} kWh / ${powerKw.toLocaleString()} kW（约 ${hours.toFixed(1)} 小时系统）。`;
    return { capacityKwh, powerKw, ePeak, hPeak, hValley, peakKw, transformerKVA, explain };
  },

  /**
   * @param {object} base 基础配置（同 Engine.run 的 cfg，含已选设备与默认参数）
   * @param {object} cons 约束 { budget, areaM2, maxPvKw, maxStorageKwh, objective }
   * @param {function} [onProgress] 进度回调(0..1)
   */
  optimizeCapacity(base, cons, onProgress) {
    const objective = cons.objective || 'maxNpv';
    const region = REGIONS[base.regionKey];

    // ---- 推导搜索上界 ----
    // 光伏上界：受场地面积、预算、以及"年发电不宜远超年用电"约束
    const _monthly = (base.load.monthly && base.load.monthly.length === 12) ? base.load.monthly : null;
    const annualKwh = _monthly ? _monthly.reduce((a, b) => a + (+b || 0), 0) : base.load.annualKwh;
    const pvByLoad = (annualKwh / region.pvYield) * 1.3;       // 发电≈1.3×用电封顶（避免过度上网）
    const pvByArea = cons.areaM2 ? cons.areaM2 / base.pv.areaPerKw : Infinity;
    let pvMax = Math.min(cons.maxPvKw || Infinity, pvByLoad, pvByArea);
    if (!isFinite(pvMax) || pvMax <= 0) pvMax = pvByLoad;

    // 储能上界：受功率/峰段电量需求约束（约 2~4 小时峰段负荷）
    const peakKw = base.load.peakKw || (annualKwh / 365 / 24) * 2;
    const storeByPeak = peakKw * 4;                            // 4 小时峰段
    let storeMax = Math.min(cons.maxStorageKwh || Infinity, storeByPeak * 1.5);
    if (!isFinite(storeMax) || storeMax <= 0) storeMax = storeByPeak;

    // ---- 网格搜索 ----
    const pvSteps = base.selected.pv ? 8 : 1;
    const storeSteps = base.selected.storage ? 8 : 1;
    const pvVals = this._linspace(0, pvMax, pvSteps, base.selected.pv);
    const storeVals = this._linspace(0, storeMax, storeSteps, base.selected.storage);

    let best = null;
    const trials = [];
    const total = pvVals.length * storeVals.length;
    let done = 0;

    for (const pvKw of pvVals) {
      for (const storeKwh of storeVals) {
        const cfg = this._withCapacity(base, pvKw, storeKwh, region);
        // 预算约束
        const result = Engine.run(cfg);
        if (cons.budget && result.capex > cons.budget) { done++; continue; }

        const score = this._score(result, objective);
        const rec = { pvKw, storeKwh, storeKw: cfg.storage.powerKw, capex: result.capex, result, score };
        trials.push(rec);
        if (!best || score > best.score) best = rec;
        done++;
        if (onProgress) onProgress(done / total);
      }
    }

    // ---- 局部细化（围绕最优点更细搜索一次）----
    if (best && (base.selected.pv || base.selected.storage)) {
      const pvLo = Math.max(0, best.pvKw - pvMax / pvSteps);
      const pvHi = Math.min(pvMax, best.pvKw + pvMax / pvSteps);
      const stLo = Math.max(0, best.storeKwh - storeMax / storeSteps);
      const stHi = Math.min(storeMax, best.storeKwh + storeMax / storeSteps);
      const pvFine = base.selected.pv ? this._linspace(pvLo, pvHi, 5, true) : [best.pvKw];
      const stFine = base.selected.storage ? this._linspace(stLo, stHi, 5, true) : [best.storeKwh];
      for (const pvKw of pvFine) {
        for (const storeKwh of stFine) {
          const cfg = this._withCapacity(base, pvKw, storeKwh, region);
          const result = Engine.run(cfg);
          if (cons.budget && result.capex > cons.budget) continue;
          const score = this._score(result, objective);
          if (!best || score > best.score) {
            best = { pvKw, storeKwh, storeKw: cfg.storage.powerKw, capex: result.capex, result, score };
          }
        }
      }
    }

    // 生成可解释建议
    const explain = this._explain(best, base, cons, objective);
    return { best, trials, explain, bounds: { pvMax, storeMax } };
  },

  /** 比较三种调度策略，返回收益最高者 */
  optimizeDispatch(base) {
    const strategies = [
      { key: 'arbitrage', label: '纯峰谷套利', strategy: ['arbitrage'] },
      { key: 'arbitrage_demand', label: '套利 + 需量削峰', strategy: ['arbitrage', 'demand'] },
      { key: 'arbitrage_plus', label: '套利 + 平段补充充电', strategy: ['arbitrage_plus'] }
    ];
    const results = strategies.map(s => {
      const cfg = { ...base, strategy: s.strategy, dispatchMode: s.key === 'arbitrage_plus' ? 'arbitrage_plus' : 'arbitrage' };
      const r = Engine.run(cfg);
      return { ...s, npv: r.finance.npv, irr: r.finance.irr, payback: r.finance.paybackStatic, result: r };
    });
    results.sort((a, b) => b.npv - a.npv);
    return { best: results[0], all: results };
  },

  // ---------------- 内部工具 ----------------
  _linspace(lo, hi, n, enabled) {
    if (!enabled) return [0];
    if (n <= 1) return [hi];
    const arr = [];
    for (let i = 0; i < n; i++) arr.push(lo + (hi - lo) * i / (n - 1));
    return arr.map(v => Math.round(v));
  },

  _withCapacity(base, pvKw, storeKwh, region) {
    const cfg = JSON.parse(JSON.stringify(base));
    cfg.selected.pv = pvKw > 0 && base.selected.pv;
    cfg.selected.storage = storeKwh > 0 && base.selected.storage;
    cfg.pv.capacityKw = pvKw;
    cfg.storage.capacityKwh = storeKwh;
    // 储能功率按 0.5C 配置（2 小时系统），符合工商业主流
    cfg.storage.powerKw = Math.round(storeKwh * 0.5);
    return cfg;
  },

  _score(result, objective) {
    const f = result.finance;
    switch (objective) {
      case 'minPayback':
        return -(isFinite(f.paybackStatic) ? f.paybackStatic : 999);
      case 'maxIrr':
        return f.irr === null ? -999 : f.irr;
      case 'maxNpv':
      default:
        return f.npv;
    }
  },

  _explain(best, base, cons, objective) {
    if (!best) return '在给定约束下未找到可行方案，请放宽预算或场地限制。';
    const f = best.result.finance;
    const objName = { maxNpv: '净现值最大', minPayback: '回本最快', maxIrr: '收益率最高' }[objective];
    const parts = [];
    parts.push(`以「${objName}」为目标，最优配置为：`);
    if (best.pvKw > 0) parts.push(`光伏 ${this._fmt(best.pvKw)} kW`);
    if (best.storeKwh > 0) parts.push(`储能 ${this._fmt(best.storeKwh)} kWh / ${this._fmt(best.storeKw)} kW`);
    let s = parts.join('，') + '。';
    s += `\n预计总投资 ${this._money(best.capex)}，`;
    s += `净现值 ${this._money(f.npv)}，`;
    s += `内部收益率 ${f.irr !== null ? (f.irr * 100).toFixed(1) + '%' : '—'}，`;
    s += `静态回本 ${isFinite(f.paybackStatic) ? f.paybackStatic.toFixed(1) + ' 年' : '不可回本'}。`;
    if (cons.budget) s += `\n（预算上限 ${this._money(cons.budget)}）`;
    if (cons.areaM2) s += `（可用面积 ${this._fmt(cons.areaM2)} m²）`;
    return s;
  },

  _fmt(n) { return Math.round(n).toLocaleString('zh-CN'); },
  _money(n) {
    if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + ' 亿元';
    if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(1) + ' 万元';
    return Math.round(n).toLocaleString('zh-CN') + ' 元';
  }
};

if (typeof module !== 'undefined') module.exports = { Optimizer };
