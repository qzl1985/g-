/**
 * engine.js — 仿真测算引擎
 * 负责把"设备配置 + 地区电价 + 负荷"转化为逐时能量流与年度收益，
 * 再交给 Finance 汇总财务指标。
 *
 * 双档精度：
 *   - simplified：1 个代表日 × 365，快速估算
 *   - professional：8760 小时逐时仿真（季节/天气/工作日波动）
 *
 * 设备：光伏 pv / 储能 storage / 充电桩 charger / 柴发 diesel，可任意组合。
 */

const Engine = {
  /** 取某小时电价（兜底：时段表缺失则按平段处理，避免 NaN） */
  priceAt(region, hour) {
    const tier = region.tou.schedule[hour] || 'flat';
    const price = region.tou[tier] ?? region.tou.flat;
    return { tier, price };
  },

  /**
   * 构造代表日负荷曲线（24h, kWh/h）
   * @param annualKwh 年用电量
   * @param profileKey 负荷类型
   */
  buildLoadDay(annualKwh, profileKey) {
    const shape = (LOAD_PROFILES[profileKey] || LOAD_PROFILES.double_shift).shape;
    const dailyTotal = annualKwh / 365;
    const sumShape = shape.reduce((a, b) => a + b, 0);
    return shape.map(s => (s / sumShape) * dailyTotal);
  },

  /**
   * 构造代表日光伏出力曲线（24h, kWh/h），按地区年发电量缩放
   * @param capacityKw 装机
   * @param region
   * @param yearDegradeFactor 当年衰减系数(≤1)
   * @param monthFactor 月度辐照系数(专业版传入，简化版=1)
   */
  buildPvDay(capacityKw, region, yearDegradeFactor = 1, monthFactor = 1) {
    const annualGen = capacityKw * region.pvYield * yearDegradeFactor; // kWh/年
    const dailyGen = (annualGen / 365) * monthFactor;
    const sumShape = PV_PROFILE_BASE.reduce((a, b) => a + b, 0);
    return PV_PROFILE_BASE.map(s => (s / sumShape) * dailyGen);
  },

  /**
   * 单日逐时调度（核心算法）
   * 规则：PV 优先自用 → 余电充储能 → 仍有余则上网；
   *       储能在谷段充电、峰/尖峰放电（套利）；可选削峰（限制最大需量）。
   * @returns 当日各项能量与成本
   */
  dispatchDay({ loadDay, pvDay, region, storage, strategy, demandCap }) {
    let soc = storage ? storage.capacityKwh * storage.minSoc : 0; // 当前电量 kWh
    const usableMax = storage ? storage.capacityKwh * storage.dod : 0;
    const socMin = storage ? storage.capacityKwh * storage.minSoc : 0;
    const chgEff = storage ? Math.sqrt(storage.efficiency) : 1;
    const dischgEff = storage ? Math.sqrt(storage.efficiency) : 1;

    let cost = 0;            // 购电成本
    let exportRevenue = 0;   // 上网收入
    let pvSelfUse = 0;       // 光伏自用电量
    let pvExport = 0;        // 光伏上网电量
    let gridImport = 0;      // 总购电量
    let storeThroughput = 0; // 储能放电量（计循环）
    let peakImport = 0;      // 当日最大单时购电（近似需量）

    for (let h = 0; h < 24; h++) {
      const { tier, price } = this.priceAt(region, h);
      const pv = pvDay[h] || 0;
      const load = loadDay[h] || 0;

      // 1) 光伏先供负荷
      let pvToLoad = Math.min(pv, load);
      pvSelfUse += pvToLoad;
      let loadRemain = load - pvToLoad;
      let pvSurplus = pv - pvToLoad;

      // 2) 储能动作
      let dischargeToLoad = 0;
      let chargeFromGrid = 0;
      let chargeFromPv = 0;

      if (storage) {
        const isPeak = (tier === 'peak' || tier === 'sharp');
        const isValley = (tier === 'valley');
        const isFlat = (tier === 'flat');

        // 余电优先充储能（无论时段，绿电不浪费）
        if (pvSurplus > 0 && soc < socMin + usableMax) {
          const room = (socMin + usableMax) - soc;
          const wantChg = Math.min(pvSurplus, storage.powerKw);
          chargeFromPv = Math.min(wantChg, room / chgEff);
          soc += chargeFromPv * chgEff;
          pvSurplus -= chargeFromPv;
        }

        if (isPeak) {
          // 峰/尖峰放电供负荷（套利）
          const avail = soc - socMin;
          const want = Math.min(loadRemain, storage.powerKw);
          dischargeToLoad = Math.min(want, avail * dischgEff);
          soc -= dischargeToLoad / dischgEff;
          loadRemain -= dischargeToLoad;
          storeThroughput += dischargeToLoad;
        } else if (isValley || (isFlat && strategy === 'arbitrage_plus')) {
          // 谷段（及可选平段）从电网充电备峰
          const room = (socMin + usableMax) - soc;
          if (room > 0) {
            const want = Math.min(storage.powerKw - chargeFromPv, room / chgEff);
            chargeFromGrid = Math.max(0, want);
            soc += chargeFromGrid * chgEff;
          }
        }
      }

      // 3) 削峰（需量管理）：限制该时购电不超过 demandCap，超出部分用储能补（已尽力）
      // 此处简化为统计峰值，真正的容量约束由优化器调整 demandCap
      let hourImport = loadRemain + chargeFromGrid;
      if (demandCap && hourImport > demandCap && storage) {
        const over = hourImport - demandCap;
        const avail = soc - socMin;
        const extra = Math.min(over, storage.powerKw - dischargeToLoad, avail * dischgEff);
        if (extra > 0) {
          soc -= extra / dischgEff;
          loadRemain -= extra;
          storeThroughput += extra;
          hourImport -= extra;
        }
      }

      // 4) 结算
      gridImport += hourImport;
      cost += hourImport * price;
      peakImport = Math.max(peakImport, hourImport);

      // 剩余光伏上网
      if (pvSurplus > 0) {
        pvExport += pvSurplus;
        exportRevenue += pvSurplus * region.feedInPrice;
      }
    }

    return { cost, exportRevenue, pvSelfUse, pvExport, gridImport, storeThroughput, peakImport };
  },

  /**
   * 基准（无任何投资）日成本：纯电网供电
   */
  baselineDay(loadDay, region) {
    let cost = 0, peak = 0;
    for (let h = 0; h < 24; h++) {
      const { price } = this.priceAt(region, h);
      cost += loadDay[h] * price;
      peak = Math.max(peak, loadDay[h]);
    }
    return { cost, peak };
  },

  /**
   * 充电桩年度测算（相对独立的收入型资产）
   */
  chargerYear(charger, region) {
    const dailyEnergy = charger.count * charger.powerKw * charger.utilizationHours; // kWh/日
    const annualEnergy = dailyEnergy * 365;
    // 购电成本：按谷段比例与平均电价混合
    const avgPrice = region.tou.valley * charger.occupyValley +
                     region.tou.flat * (1 - charger.occupyValley);
    const purchaseCost = annualEnergy * avgPrice;
    const serviceRevenue = annualEnergy * charger.serviceFee;
    const om = charger.count * charger.omPerUnitYear;
    return {
      annualEnergy,
      revenue: serviceRevenue,            // 服务费收入
      purchaseCost,                       // 代收代付的电费（净额=服务费）
      om,
      net: serviceRevenue - om            // 净收益（电费由车主承担，服务费为毛利）
    };
  },

  /**
   * 柴发年度测算（成本型/备用，或调峰收益）
   */
  dieselYear(diesel, region) {
    const annualEnergy = diesel.capacityKw * diesel.loadFactor * diesel.runHoursYear; // kWh
    const fuelCost = annualEnergy * diesel.fuelPerKwh * diesel.fuelPrice;
    const om = annualEnergy * diesel.omPerKwhYear;
    const dieselCostPerKwh = (fuelCost + om) / (annualEnergy || 1);
    // 若发电成本低于尖峰电价，则在尖峰时段顶峰可省钱（调峰价值）
    const peakPrice = region.tou.sharp;
    const savingPerKwh = Math.max(0, peakPrice - dieselCostPerKwh);
    const peakShaveValue = savingPerKwh * annualEnergy;
    const carbon = annualEnergy * diesel.fuelPerKwh * diesel.carbonPerL / 1000; // tCO2
    return {
      annualEnergy, fuelCost, om,
      costPerKwh: dieselCostPerKwh,
      peakShaveValue,           // 作为正收益（替代尖峰购电）
      carbon,
      net: peakShaveValue - 0   // 备用场景净收益≈调峰价值（燃料计入其中）
    };
  },

  /**
   * 主测算入口
   * @param {object} cfg 完整配置（见 app.js 组装）
   * @returns 完整结果对象（年度明细 + 财务指标）
   */
  run(cfg) {
    const region = REGIONS[cfg.regionKey];
    const sel = cfg.selected;            // {pv:bool, storage:bool, charger:bool, diesel:bool}
    const mode = cfg.mode || 'simplified';
    const years = cfg.projectYears || 25;
    const discountRate = cfg.discountRate ?? 0.06;

    // ---------- 容量与造价 ----------
    let capex = 0;
    const capexBreakdown = {};
    if (sel.pv) {
      const c = cfg.pv.capacityKw * cfg.pv.capexPerW * 1000;
      capex += c; capexBreakdown.pv = c;
    }
    if (sel.storage) {
      const c = cfg.storage.capacityKwh * cfg.storage.capexPerWh * 1000;
      capex += c; capexBreakdown.storage = c;
    }
    if (sel.charger) {
      const c = cfg.charger.count * cfg.charger.capexPerUnit;
      capex += c; capexBreakdown.charger = c;
    }
    if (sel.diesel) {
      const c = cfg.diesel.capacityKw * cfg.diesel.capexPerW * 1000;
      capex += c; capexBreakdown.diesel = c;
    }

    // ---------- 负荷曲线 ----------
    const loadDay = this.buildLoadDay(cfg.load.annualKwh, cfg.load.profile);
    const baseDay = this.baselineDay(loadDay, region);
    const baselineAnnualCost = baseDay.cost * 365 +
      (region.demandCharge * (cfg.load.peakKw || baseDay.peak) * 12);

    // ---------- 逐年模拟 ----------
    const annualNet = [];
    const omByYear = [];
    const energyByYear = [];
    let totalPvGen = 0, totalCarbonCut = 0, totalStoreThroughput = 0;

    // 充电桩、柴发年值（首年，后续按通胀/衰减简单处理，这里保持稳定）
    const chg = sel.charger ? this.chargerYear(cfg.charger, region) : null;
    const dsl = sel.diesel ? this.dieselYear(cfg.diesel, region) : null;

    for (let y = 0; y < years; y++) {
      // 光伏衰减系数
      let pvFactor = 1;
      if (sel.pv) {
        pvFactor = (y === 0) ? (1 - cfg.pv.degradationY1)
                             : (1 - cfg.pv.degradationY1) * Math.pow(1 - cfg.pv.degradation, y);
      }
      // 储能容量衰减（影响可用量）
      let storeForYear = null;
      if (sel.storage) {
        const cap = cfg.storage.capacityKwh * Math.pow(1 - cfg.storage.degradation, y);
        storeForYear = { ...cfg.storage, capacityKwh: cap };
      }

      let yearGridCost = 0, yearExport = 0, yearPvSelf = 0, yearPvExport = 0;
      let yearPeak = 0, yearThroughput = 0;

      const daysIter = mode === 'professional' ? 12 : 1; // 专业版按 12 个月分别算
      for (let m = 0; m < daysIter; m++) {
        const monthFactor = mode === 'professional' ? MONTHLY_IRRADIANCE[m] : 1;
        const dayCount = mode === 'professional' ? this._daysInMonth(m) : 365;

        const pvDay = sel.pv ? this.buildPvDay(cfg.pv.capacityKw, region, pvFactor, monthFactor)
                             : new Array(24).fill(0);

        // 削峰目标：若启用需量管理，设为基准峰值的 75%
        const demandCap = (sel.storage && cfg.strategy && cfg.strategy.includes('demand'))
          ? (cfg.load.peakKw || baseDay.peak) * 0.75 : null;

        const d = this.dispatchDay({
          loadDay, pvDay, region,
          storage: storeForYear,
          strategy: cfg.dispatchMode || 'arbitrage',
          demandCap
        });

        yearGridCost += d.cost * dayCount;
        yearExport += d.exportRevenue * dayCount;
        yearPvSelf += d.pvSelfUse * dayCount;
        yearPvExport += d.pvExport * dayCount;
        yearThroughput += d.storeThroughput * dayCount;
        yearPeak = Math.max(yearPeak, d.peakImport);
      }

      // 需量电费（按削峰后峰值）
      const demandCost = region.demandCharge * yearPeak * 12;
      const energyCostWithSystem = yearGridCost + demandCost;

      // 运维
      let om = 0;
      if (sel.pv) om += cfg.pv.capacityKw * cfg.pv.omPerKwYear;
      if (sel.storage) om += cfg.storage.capacityKwh * cfg.storage.omPerKwhYear;
      if (sel.charger) om += chg.om;
      if (sel.diesel) om += dsl.om;

      // 当年净收益 = 电费节省 + 上网收入 + 充电桩净收入 + 柴发调峰价值 − 运维
      const electricitySaving = baselineAnnualCost - energyCostWithSystem;
      let net = electricitySaving + yearExport - om;
      if (sel.charger) net += chg.net;
      if (sel.diesel) net += dsl.peakShaveValue;

      // 储能到寿命需更换（第 lifeYears 年末计入更换成本）
      if (sel.storage && cfg.storage.lifeYears && (y + 1) === cfg.storage.lifeYears && (y + 1) < years) {
        const replaceCost = cfg.storage.capacityKwh * cfg.storage.capexPerWh * 1000 * 0.6; // 电芯降价，按 60%
        net -= replaceCost;
      }

      annualNet.push(net);
      omByYear.push(om);
      // 供电量（用于 LCOE）：自用光伏+储能放电+负荷被满足部分
      energyByYear.push(yearPvSelf + yearThroughput);

      totalPvGen += (yearPvSelf + yearPvExport);
      totalStoreThroughput += yearThroughput;
      if (sel.pv) totalCarbonCut += (yearPvSelf + yearPvExport) * region.carbonFactor / 1000;
      if (sel.diesel) totalCarbonCut -= dsl.carbon;
    }

    // 残值（光伏 5%，储能按剩余寿命）
    let residual = 0;
    if (sel.pv) residual += capexBreakdown.pv * 0.05;

    const fin = Finance.summarize({
      capex, annualNet, discountRate, residual, omByYear, energyByYear
    });

    return {
      region, mode, years,
      capex, capexBreakdown,
      baselineAnnualCost,
      annualNet, omByYear,
      finance: fin,
      env: {
        carbonCut: totalCarbonCut,    // tCO2 全周期
        pvGenTotal: totalPvGen,
        storeThroughput: totalStoreThroughput
      },
      detail: { charger: chg, diesel: dsl, loadDay, peakKw: cfg.load.peakKw || baseDay.peak }
    };
  },

  _daysInMonth(m) {
    return [31,28,31,30,31,30,31,31,30,31,30,31][m];
  }
};

if (typeof module !== 'undefined') module.exports = { Engine };
