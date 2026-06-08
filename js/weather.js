/**
 * weather.js — 气象与倾斜面辐照（模块A 之资源层）
 *
 * 提供各地区近似 TMY（典型气象年）关键量：年水平面总辐照 GHI、逐月辐照分布、
 * 逐月平均气温、辐照年际变异系数 σ（用于 P50/P90）。
 * 并提供把水平面辐照转换为倾斜面辐照 POA 的月度模型（简化各向同性 + 几何 Rb）。
 *
 * 说明：内置库为工程近似，用于可研/预可研估算；支持上传逐时辐照另行接入。
 */

const Weather = {
  // 地区近似 TMY 库（annualGHI: kWh/m²·年；latitude 用于倾角转换）
  TMY: {
    cn_ci_east:   { name: '华东', lat: 31, annualGHI: 1300, sigma: 0.05,
      monthFrac: [0.058,0.062,0.082,0.092,0.100,0.098,0.105,0.100,0.085,0.078,0.072,0.068],
      temp:      [4,6,11,17,22,26,30,29,25,19,12,6] },
    cn_ci_north:  { name: '华北', lat: 39, annualGHI: 1480, sigma: 0.055,
      monthFrac: [0.055,0.062,0.085,0.095,0.108,0.105,0.100,0.098,0.090,0.078,0.064,0.060],
      temp:      [-3,0,7,15,21,26,28,27,22,15,6,-1] },
    cn_ci_south:  { name: '华南', lat: 23, annualGHI: 1200, sigma: 0.05,
      monthFrac: [0.060,0.058,0.068,0.078,0.092,0.095,0.110,0.105,0.098,0.092,0.078,0.066],
      temp:      [14,15,18,23,26,28,29,29,28,25,21,16] },
    cn_residential:{ name: '通用', lat: 31, annualGHI: 1300, sigma: 0.05,
      monthFrac: [0.058,0.062,0.082,0.092,0.100,0.098,0.105,0.100,0.085,0.078,0.072,0.068],
      temp:      [4,6,11,17,22,26,30,29,25,19,12,6] },
    overseas_eu:  { name: '欧洲', lat: 48, annualGHI: 1150, sigma: 0.06,
      monthFrac: [0.030,0.045,0.075,0.100,0.125,0.130,0.130,0.115,0.090,0.060,0.035,0.025],
      temp:      [2,3,7,11,15,19,21,20,16,11,6,3] }
  },

  tmy(regionKey) {
    const t = this.TMY[regionKey] || this.TMY.cn_residential;
    const monthlyGHI = t.monthFrac.map(f => +(t.annualGHI * f).toFixed(1)); // kWh/m²·月
    return { name: t.name, lat: t.lat, annualGHI: t.annualGHI, sigma: t.sigma,
             monthlyGHI, tempMonthly: t.temp.slice() };
  },

  /**
   * 倾斜面月度辐照 POA（kWh/m²·月）
   * 简化模型：直射按几何 Rb（正午入射比）放大，散射按各向同性 (1+cosβ)/2，
   * 地面反射 albedo·(1-cosβ)/2；非正南方位按 cos(方位偏角) 折减直射分量。
   */
  poaMonthly({ lat, tilt, azimuth = 0, albedo = 0.2, monthlyGHI }) {
    const rad = Math.PI / 180;
    const midDay = [17, 47, 75, 105, 135, 162, 198, 228, 258, 288, 318, 344]; // 各月代表日序号
    const beamFrac = 0.82, diffFrac = 0.18;     // 典型直射/散射占比
    const azFactor = Math.max(0.6, Math.cos(azimuth * rad)); // 方位偏离正南折减
    return monthlyGHI.map((ghi, m) => {
      const decl = 23.45 * Math.sin(2 * Math.PI * (284 + midDay[m]) / 365);
      const cosTilt = Math.sin(decl * rad) * Math.sin((lat - tilt) * rad) +
                      Math.cos(decl * rad) * Math.cos((lat - tilt) * rad);
      const cosHorz = Math.sin(decl * rad) * Math.sin(lat * rad) +
                      Math.cos(decl * rad) * Math.cos(lat * rad);
      let rb = (cosHorz > 0.05) ? cosTilt / cosHorz : 1;
      rb = Math.max(0.4, Math.min(1.8, rb));    // 防御性钳位
      const tiltRad = tilt * rad;
      const poa = ghi * (beamFrac * rb * azFactor +
                         diffFrac * (1 + Math.cos(tiltRad)) / 2 +
                         albedo * (1 - Math.cos(tiltRad)) / 2);
      return +poa.toFixed(1);
    });
  },

  // 经验最佳倾角（≈ 纬度的近似），用于"最佳倾角"快捷选项
  optimalTilt(lat) { return Math.round(Math.max(0, Math.min(40, lat * 0.87))); }
};

if (typeof module !== 'undefined') module.exports = { Weather };
