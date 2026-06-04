/**
 * optimizer.js — AI 容量优化与策略寻优
 *
 * 1) optimizeCapacity：在预算/场地/负荷约束下，搜索光伏+储能(+充电桩)最优容量组合。
 *    目标可选：maxNpv（净现值最大）/ minPayback（回本最快）/ maxIrr（收益率最高）。
 *    采用"粗粒度网格搜索 + 局部细化"的启发式，兼顾速度与质量，结果可解释。
 *
 * 2) optimizeDispatch：评估不同储能调度策略（套利 / 套利+削峰 / 套利+平段充电），
 *    选出收益最高者。
 */

const Optimizer = {
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
    const annualKwh = base.load.annualKwh;
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
