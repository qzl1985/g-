/**
 * storagemodel.js — 储能精细化建模（模块B · 对标 GB51048）
 *
 * 由储能参数（容量/功率/DoD/往返效率/电池循环寿命/日历寿命/EOL）与逐年放电量，
 * 计算：年等效满充放循环 EFC、逐年 SOH（循环+日历衰减取较大者）、到 EOL 的更换年份、
 * 自耗电、平准化储能度电成本 LCOS。
 *
 * 依赖：DEVICE_DB（可选，取电池型号参数）。DOM-free，可在 vm 测试。
 */

const StorageModel = {
  /**
   * @param {object} p
   *   capacityKwh, powerKw, dod, etaRt(往返效率), batteryId?,
   *   cycleLife?, calendarLife?, eolSoh?, capexPerWh?, omPerKwhYear?,
   *   auxRatio?(自耗电占额定/年, 如 0.02),
   *   throughputByYear[](逐年放电量 kWh), years, discountRate
   */
  evaluate(p) {
    const bat = (typeof DEVICE_DB !== 'undefined' && p.batteryId) ? DEVICE_DB.battery(p.batteryId) : null;
    const cycleLife = p.cycleLife || (bat && bat.cycleLife) || 6000;
    const calendarLife = p.calendarLife || (bat && bat.calendarLife) || 12;
    const eolSoh = p.eolSoh || (bat && bat.eolSoh) || 0.8;
    const dod = p.dod || 0.95;
    const cap = p.capacityKwh || 0;
    const years = p.years || 25;
    const ic = (p.discountRate != null) ? p.discountRate : 0.06;
    const tp = p.throughputByYear || [];

    const cycleLossPerCycle = (1 - eolSoh) / cycleLife;   // 每循环容量损失
    const calLossPerYear = (1 - eolSoh) / calendarLife;   // 每年日历损失

    const sohByYear = [], efcByYear = [], replaceYears = [];
    let cumCycleLoss = 0, calAge = 0;
    let totalEfc = 0;

    for (let y = 0; y < years; y++) {
      const throughput = tp[y] || 0;
      const efc = cap > 0 ? throughput / (cap * dod) : 0;   // 年等效满充放循环
      efcByYear.push(efc);
      totalEfc += efc;
      cumCycleLoss += efc * cycleLossPerCycle;
      calAge += 1;
      const calLoss = calLossPerYear * calAge;
      const loss = Math.max(cumCycleLoss, calLoss);          // 循环/日历取较大
      let soh = 1 - loss;
      if (soh <= eolSoh) {
        replaceYears.push(y + 1);                            // 该年末更换
        cumCycleLoss = 0; calAge = 0;                        // 换新电池：循环与日历均重置
        soh = 1;
      }
      sohByYear.push(+Math.max(eolSoh, Math.min(1, soh)).toFixed(4));
    }

    // 自耗电（温控/BMS）
    const auxRatio = (p.auxRatio != null) ? p.auxRatio : 0.02;
    const auxEnergyYear = cap * auxRatio * 365 * 0;          // 预留, 此处并入O&M, 不重复计

    // LCOS：全生命周期储能成本现值 / 放电量现值
    const capex = (p.capexPerWh != null) ? cap * p.capexPerWh * 1000 : (cap * 1000 * 1.0);
    const omYear = (p.omPerKwhYear != null) ? cap * p.omPerKwhYear : cap * 20;
    let costPV = capex, energyPV = 0;
    for (let y = 0; y < years; y++) {
      const d = Math.pow(1 + ic, y + 1);
      costPV += omYear / d;
      if (replaceYears.indexOf(y + 1) >= 0) costPV += capex * 0.6 / d;  // 换新(电芯降价按60%)
      energyPV += (tp[y] || 0) / d;
    }
    const lcos = energyPV > 0 ? costPV / energyPV : null;

    return {
      cycleLife, calendarLife, eolSoh,
      efcAvg: years > 0 ? +(totalEfc / years).toFixed(1) : 0,
      sohByYear, efcByYear, replaceYears,
      endSoh: sohByYear[sohByYear.length - 1],
      lcos, auxEnergyYear
    };
  }
};

if (typeof module !== 'undefined') module.exports = { StorageModel };
