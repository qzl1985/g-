/**
 * forecast.js — 负荷与发电预测
 *
 * 在用户只提供少量信息（如月电费、峰值负荷、行业类型）时，
 * 反推年用电量、负荷曲线，并预测光伏年发电量与逐时出力。
 * 采用基于行业典型曲线 + 地区光照的工程估算法，结果可解释、可调。
 */

const Forecast = {
  /**
   * 由月均电费反推年用电量
   * @param monthlyBill 月均电费(元)
   * @param avgPrice 综合平均电价(元/kWh)，不传则按地区估算
   */
  estimateAnnualKwhFromBill(monthlyBill, region, profileKey) {
    const avgPrice = this._avgPrice(region, profileKey);
    const monthlyKwh = monthlyBill / avgPrice;
    return Math.round(monthlyKwh * 12);
  },

  /**
   * 由峰值负荷反推年用电量（基于负荷率）
   * @param peakKw 峰值功率
   * @param loadFactor 负荷率（典型 0.3~0.7，越连续越高）
   */
  estimateAnnualKwhFromPeak(peakKw, profileKey) {
    const lf = this._typicalLoadFactor(profileKey);
    return Math.round(peakKw * 8760 * lf);
  },

  /** 估算峰值负荷（由年用电量 + 负荷类型） */
  estimatePeakKw(annualKwh, profileKey) {
    const lf = this._typicalLoadFactor(profileKey);
    return Math.round(annualKwh / 8760 / lf);
  },

  /**
   * 预测光伏年发电与逐月出力
   */
  predictPv(capacityKw, region) {
    const annual = capacityKw * region.pvYield;
    const monthly = MONTHLY_IRRADIANCE.map((f, i) => {
      const days = [31,28,31,30,31,30,31,31,30,31,30,31][i];
      const weight = f * days;
      return weight;
    });
    const wSum = monthly.reduce((a, b) => a + b, 0);
    const monthlyGen = monthly.map(w => Math.round(annual * w / wSum));
    return { annual: Math.round(annual), monthlyGen };
  },

  /**
   * 综合预测：把零散输入补全为完整测算所需的负荷画像
   * @param input { monthlyBill?, peakKw?, annualKwh?, profile, regionKey }
   */
  buildLoadProfile(input) {
    const region = REGIONS[input.regionKey];
    const profile = input.profile || 'double_shift';
    let annualKwh = input.annualKwh;
    let peakKw = input.peakKw;
    let source = '直接输入';

    if (!annualKwh && input.monthlyBill) {
      annualKwh = this.estimateAnnualKwhFromBill(input.monthlyBill, region, profile);
      source = '由月电费推算';
    }
    if (!annualKwh && peakKw) {
      annualKwh = this.estimateAnnualKwhFromPeak(peakKw, profile);
      source = '由峰值负荷推算';
    }
    if (!peakKw && annualKwh) {
      peakKw = this.estimatePeakKw(annualKwh, profile);
    }
    return { annualKwh: annualKwh || 0, peakKw: peakKw || 0, profile, source };
  },

  // -------- 内部 --------
  _avgPrice(region, profileKey) {
    // 按负荷曲线在各时段的分布加权平均电价
    const shape = (LOAD_PROFILES[profileKey] || LOAD_PROFILES.double_shift).shape;
    let num = 0, den = 0;
    for (let h = 0; h < 24; h++) {
      const tier = region.tou.schedule[h];
      num += shape[h] * region.tou[tier];
      den += shape[h];
    }
    return num / den;
  },

  _typicalLoadFactor(profileKey) {
    return ({
      single_shift: 0.33,
      double_shift: 0.50,
      three_shift: 0.78,
      commercial: 0.40,
      residential: 0.30
    })[profileKey] || 0.45;
  }
};

if (typeof module !== 'undefined') module.exports = { Forecast };
