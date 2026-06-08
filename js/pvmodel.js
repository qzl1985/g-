/**
 * pvmodel.js — 组件级光伏发电模型（模块A · 对标 GB50797 / PVsyst 思路）
 *
 * 由气象(POA、气温) + 组件参数(温度系数/NOCT/衰减) + 逆变器效率 + 系统损失
 * 计算逐月/年发电量、系统效率 PR、等效利用小时，并给出 P50/P90 保证出力。
 *
 * 依赖：Weather、DEVICE_DB（全局）。DOM-free，可在 vm 中测试。
 */

const PvModel = {
  /**
   * @param {object} p
   *   regionKey, lat?(覆盖), capacityKw, tilt, azimuth, albedo,
   *   moduleId, dcac(容配比), invEffMax,
   *   losses: { line, mismatch, soiling, avail }  // 各项损失(0~1)
   *   year (第几年, 用于衰减; 0 = 首年)
   * @returns { monthlyGen[12], annual, pr, hours, p50, p90, p90Annual, detail }
   */
  generate(p) {
    const tmy = Weather.tmy(p.regionKey);
    const lat = (p.lat != null) ? p.lat : tmy.lat;
    const tilt = (p.tilt != null) ? p.tilt : Weather.optimalTilt(lat);
    const azimuth = p.azimuth || 0;
    const albedo = (p.albedo != null) ? p.albedo : 0.2;
    const mod = (typeof DEVICE_DB !== 'undefined') ? DEVICE_DB.pvModule(p.moduleId) : {
      tempCoef: -0.0030, noct: 44, degradeY1: 0.01, degrade: 0.004
    };
    const losses = p.losses || {};
    const L = (1 - (losses.line || 0.02)) * (1 - (losses.mismatch || 0.02)) *
              (1 - (losses.soiling || 0.03)) * (losses.avail != null ? losses.avail : 0.99);
    const invEff = p.invEffMax || 0.985;
    const dcac = p.dcac || 1.15;

    // 衰减系数（首年 + 逐年）
    const y = p.year || 0;
    const degrade = (y === 0) ? (1 - mod.degradeY1)
                              : (1 - mod.degradeY1) * Math.pow(1 - mod.degrade, y);

    const poa = Weather.poaMonthly({ lat, tilt, azimuth, albedo, monthlyGHI: tmy.monthlyGHI });
    const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

    let annual = 0;
    const monthlyGen = poa.map((poaM, m) => {
      // 组件温度（按月均气温 + NOCT 修正，用月辐照折算等效日照强度）
      const irrLevel = (poaM / days[m]) / 5.0;             // 相对峰值日照系数(粗略)
      const tcell = tmy.tempMonthly[m] + (mod.noct - 20) / 800 * 1000 * Math.min(1, irrLevel + 0.3);
      const tempFactor = 1 + mod.tempCoef * (tcell - 25);
      // 直流发电 = 装机 × POA(kWh/m²) ÷ 1(标准辐照) × 温度 × 损失 × 衰减
      let dc = p.capacityKw * poaM * tempFactor * L * degrade;
      // 逆变器效率 + 容配比限幅（简化：高容配比带来少量弃光）
      const clipLoss = dcac > 1.2 ? (1 - (dcac - 1.2) * 0.05) : 1;
      const ac = dc * invEff * clipLoss;
      annual += ac;
      return +ac.toFixed(0);
    });

    const idealAnnual = p.capacityKw * poa.reduce((a, b) => a + b, 0);
    const pr = idealAnnual > 0 ? annual / idealAnnual : 0;   // 系统效率
    const hours = p.capacityKw > 0 ? annual / p.capacityKw : 0;

    // P50/P90（基于辐照年际变异 σ，正态近似）
    const sigma = tmy.sigma || 0.05;
    const p90Annual = annual * (1 - 1.282 * sigma);
    const p75Annual = annual * (1 - 0.674 * sigma);

    return {
      monthlyGen, annual: Math.round(annual),
      pr: +pr.toFixed(3), hours: Math.round(hours),
      p50: Math.round(annual), p75: Math.round(p75Annual), p90: Math.round(p90Annual),
      detail: { lat, tilt, azimuth, sigma, poaAnnual: Math.round(poa.reduce((a, b) => a + b, 0)),
                module: mod.name || p.moduleId, degrade: +degrade.toFixed(4) }
    };
  },

  /** 多年逐年发电（含衰减），返回 annual[]（length=years），用于财务 */
  generateYears(p, years) {
    const arr = [];
    for (let y = 0; y < years; y++) arr.push(this.generate(Object.assign({}, p, { year: y })).annual);
    return arr;
  }
};

if (typeof module !== 'undefined') module.exports = { PvModel };
