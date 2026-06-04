/**
 * finance.js — 财务测算核心
 * 提供 NPV / IRR / 回本周期 / LCOE / 现金流 等通用财务指标计算。
 * 与具体设备无关，输入是逐年现金流与造价，输出标准投资指标。
 */

const Finance = {
  /**
   * 净现值 NPV
   * @param {number} rate 折现率（如 0.08）
   * @param {number[]} cashflows 现金流数组，cashflows[0] 通常为初始投资(负)
   */
  npv(rate, cashflows) {
    return cashflows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + rate, t), 0);
  },

  /**
   * 内部收益率 IRR（二分法 + 牛顿法兜底，稳定可靠）
   * @returns {number|null} 年化 IRR，无解返回 null
   */
  irr(cashflows) {
    // 必须存在正负号变化才有意义
    const hasPos = cashflows.some(c => c > 0);
    const hasNeg = cashflows.some(c => c < 0);
    if (!hasPos || !hasNeg) return null;

    // 二分法在 [-0.99, 5] 区间寻根
    let lo = -0.9, hi = 5.0;
    const f = (r) => this.npv(r, cashflows);
    let flo = f(lo), fhi = f(hi);
    if (flo * fhi > 0) {
      // 区间端点同号，尝试扩展
      hi = 100;
      fhi = f(hi);
      if (flo * fhi > 0) return null;
    }
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      const fmid = f(mid);
      if (Math.abs(fmid) < 1e-7) return mid;
      if (flo * fmid < 0) { hi = mid; fhi = fmid; }
      else { lo = mid; flo = fmid; }
    }
    return (lo + hi) / 2;
  },

  /**
   * 静态回本周期（不折现）
   * @returns {number} 年（含小数，线性插值），永不回本返回 Infinity
   */
  paybackStatic(cashflows) {
    let cum = 0;
    for (let t = 0; t < cashflows.length; t++) {
      const prev = cum;
      cum += cashflows[t];
      if (cum >= 0 && t > 0) {
        const need = -prev;            // 上一年末还差多少回本
        const thisYear = cashflows[t];
        return (t - 1) + (thisYear > 0 ? need / thisYear : 0);
      }
    }
    return Infinity;
  },

  /**
   * 动态回本周期（折现）
   */
  paybackDynamic(rate, cashflows) {
    let cum = 0;
    for (let t = 0; t < cashflows.length; t++) {
      const disc = cashflows[t] / Math.pow(1 + rate, t);
      const prev = cum;
      cum += disc;
      if (cum >= 0 && t > 0) {
        const need = -prev;
        return (t - 1) + (disc > 0 ? need / disc : 0);
      }
    }
    return Infinity;
  },

  /**
   * 平准化度电成本 LCOE
   * @param {number} rate 折现率
   * @param {number} capex 初始投资
   * @param {number[]} omByYear 各年运维成本数组（长度=寿命年）
   * @param {number[]} energyByYear 各年发电/供电量 kWh
   */
  lcoe(rate, capex, omByYear, energyByYear) {
    let costPV = capex;
    let energyPV = 0;
    for (let t = 0; t < energyByYear.length; t++) {
      const d = Math.pow(1 + rate, t + 1);
      costPV += (omByYear[t] || 0) / d;
      energyPV += (energyByYear[t] || 0) / d;
    }
    return energyPV > 0 ? costPV / energyPV : Infinity;
  },

  /**
   * 综合财务汇总：给定初始投资和逐年净收益，产出全套指标
   * @param {object} p
   * @param {number} p.capex 初始总投资（正数）
   * @param {number[]} p.annualNet 逐年净收益（不含初始投资，长度=寿命）
   * @param {number} p.discountRate 折现率
   * @param {number} [p.residual] 期末残值（计入最后一年）
   * @param {number[]} [p.omByYear] 运维成本（用于 LCOE）
   * @param {number[]} [p.energyByYear] 年供电量（用于 LCOE）
   */
  summarize(p) {
    const { capex, annualNet, discountRate, residual = 0, omByYear, energyByYear } = p;
    const cf = [-capex, ...annualNet.slice()];
    if (residual) cf[cf.length - 1] += residual;

    const npv = this.npv(discountRate, cf);
    const irr = this.irr(cf);
    const paybackS = this.paybackStatic(cf);
    const paybackD = this.paybackDynamic(discountRate, cf);
    const totalNet = annualNet.reduce((a, b) => a + b, 0) + residual;
    const roi = capex > 0 ? totalNet / capex : 0;          // 总投资回报率（全周期）
    const avgAnnual = annualNet.length ? totalNet / annualNet.length : 0;

    let lcoeVal = null;
    if (omByYear && energyByYear) {
      lcoeVal = this.lcoe(discountRate, capex, omByYear, energyByYear);
    }

    return {
      capex,
      npv,
      irr,                       // 可能为 null
      paybackStatic: paybackS,
      paybackDynamic: paybackD,
      totalNet,
      roi,
      avgAnnual,
      lcoe: lcoeVal,
      cashflows: cf,
      cumulative: cf.reduce((arr, c) => { arr.push((arr[arr.length - 1] || 0) + c); return arr; }, [])
    };
  }
};

if (typeof module !== 'undefined') module.exports = { Finance };
