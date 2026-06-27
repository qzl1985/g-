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
    const price = (region.tou[tier] != null) ? region.tou[tier] : region.tou.flat;
    return { tier, price };
  },

  /**
   * 构造代表日负荷曲线（24h, kWh/h），支持三档数据精度：
   *   - template：行业典型曲线 × 当日电量
   *   - tou：按用户给的 峰/平/谷(/尖) 电量占比分配到对应时段（套利测算更准）
   *   - hourly：用户给的 24 小时归一化负荷表 × 当日电量
   * @param dailyKwh 当日总用电量
   * @param load 负荷配置对象 {profile, dataTier, tou:{sharp,peak,flat,valley}, hourly:[24]}
   * @param region 用于读取分时时段归属
   */
  buildLoadDay(dailyKwh, load, region, shapeOverride) {
    // 8760 逐时：按"该月真实/工作日/周末"形状注入
    if (shapeOverride && shapeOverride.length === 24) {
      const sum = shapeOverride.reduce((a, b) => a + (+b || 0), 0) || 1;
      return shapeOverride.map(s => ((+s || 0) / sum) * dailyKwh);
    }
    const tier = (load && load.dataTier) || 'template';

    // 档3：逐时负荷表
    if (tier === 'hourly' && load.hourly && load.hourly.length === 24) {
      const sum = load.hourly.reduce((a, b) => a + (+b || 0), 0) || 1;
      return load.hourly.map(s => ((+s || 0) / sum) * dailyKwh);
    }

    // 档2：分时段电量占比
    if (tier === 'tou' && load.tou && region) {
      const sched = region.tou.schedule;
      const cnt = { sharp: 0, peak: 0, flat: 0, valley: 0 };
      sched.forEach(t => { if (cnt[t] !== undefined) cnt[t]++; });
      const shares = {
        sharp: +load.tou.sharp || 0, peak: +load.tou.peak || 0,
        flat: +load.tou.flat || 0, valley: +load.tou.valley || 0
      };
      // 该地区无尖峰时段时，把尖峰占比并入高峰；任何无对应时段的占比并入平段
      if (cnt.sharp === 0) { shares.peak += shares.sharp; shares.sharp = 0; }
      ['peak', 'valley'].forEach(k => { if (cnt[k] === 0) { shares.flat += shares[k]; shares[k] = 0; } });
      let stot = shares.sharp + shares.peak + shares.flat + shares.valley;
      if (stot <= 0) stot = 1;
      return sched.map(t => {
        const c = cnt[t] || 1;
        return ((shares[t] || 0) / stot) * dailyKwh / c;
      });
    }

    // 档1：行业典型曲线
    const shape = (LOAD_PROFILES[(load && load.profile)] || LOAD_PROFILES.double_shift).shape;
    const sumShape = shape.reduce((a, b) => a + b, 0);
    return shape.map(s => (s / sumShape) * dailyKwh);
  },

  /**
   * 两部制·基本电费（年）
   *   - demand：按最大需量  demandCharge(元/kW/月) × 需量(kW) × 12
   *   - capacity：按变压器容量 capacityCharge(元/kVA/月) × 容量(kVA) × 12
   *   - auto：取两者更省
   */
  basicFee(maxDemandKw, transformerKVA, region, mode) {
    const demandFee = (region.demandCharge || 0) * maxDemandKw * 12;
    const capFee = (region.capacityCharge || 0) * (transformerKVA || 0) * 12;
    if (mode === 'capacity') return { fee: capFee, basis: 'capacity' };
    if (mode === 'demand') return { fee: demandFee, basis: 'demand' };
    // auto：变压器容量电费为 0（未填）时只能按需量
    if (capFee <= 0) return { fee: demandFee, basis: 'demand' };
    return demandFee <= capFee ? { fee: demandFee, basis: 'demand' } : { fee: capFee, basis: 'capacity' };
  },

  /**
   * 构造代表日光伏出力曲线（24h, kWh/h），按地区年发电量缩放
   * @param capacityKw 装机
   * @param region
   * @param yearDegradeFactor 当年衰减系数(≤1)
   * @param monthFactor 月度辐照系数(专业版传入，简化版=1)
   */
  buildPvDay(capacityKw, region, yearDegradeFactor = 1, monthFactor = 1, yieldPerKw) {
    const y = (yieldPerKw != null) ? yieldPerKw : region.pvYield;  // 可由 PvModel 给出更精确的等效发电量
    const annualGen = capacityKw * y * yearDegradeFactor;          // kWh/年
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
    const discountRate = (cfg.discountRate != null) ? cfg.discountRate : 0.06;

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

    // ---------- 负荷与电价输入 ----------
    const load = cfg.load || {};
    const monthly = (load.monthly && load.monthly.length === 12) ? load.monthly.map(x => +x || 0) : null;
    const annualKwh = monthly ? monthly.reduce((a, b) => a + b, 0) : (load.annualKwh || 0);
    const transformerKVA = load.transformerKVA || 0;
    const basicFeeMode = load.basicFeeMode || 'auto';

    // 代表日负荷（用于峰值估算）
    const repLoadDay = this.buildLoadDay(annualKwh / 365, load, region);
    let peakKw = load.peakKw || Math.round(Math.max.apply(null, repLoadDay) * 1.3) || 1;

    // 迭代器：simplified=1代表日×365；professional=12月代表日；engineering=365日逐时(工作日/周末+分月真实形状)
    const months = [];
    const shapeFor = (m, weekend) => {
      if (weekend && load.weekendShape) return load.weekendShape;
      if (!weekend && load.weekdayShape && load.monthlyHourly && load.monthlyHourly[m]) {
        // 用该月形状的日内分布、工作日量级（量级在归一化后无关，直接用月形状）
        return load.monthlyHourly[m];
      }
      if (load.monthlyHourly && load.monthlyHourly[m]) return load.monthlyHourly[m];
      return null;
    };
    if (mode === 'engineering') {
      let doy = 0;
      for (let m = 0; m < 12; m++) {
        const dim = this._daysInMonth(m);
        const dailyKwh = (monthly ? monthly[m] : annualKwh / 12) / dim;
        for (let day = 1; day <= dim; day++) {
          const dow = (doy + 2) % 7;                 // 确定性星期（2025-01-01≈周三起，近似）
          const weekend = (dow === 0 || dow === 6);
          months.push({ m, dayCount: 1, dailyKwh, monthFactor: MONTHLY_IRRADIANCE[m], weekend, shape: shapeFor(m, weekend) });
          doy++;
        }
      }
    } else if (mode === 'professional') {
      for (let m = 0; m < 12; m++) {
        const dc = this._daysInMonth(m);
        const dailyKwh = monthly ? (monthly[m] / dc) : (annualKwh / 365);
        months.push({ m, dayCount: dc, dailyKwh, monthFactor: MONTHLY_IRRADIANCE[m], shape: shapeFor(m, false) });
      }
    } else {
      months.push({ m: -1, dayCount: 365, dailyKwh: annualKwh / 365, monthFactor: 1 });
    }

    // 8760 负荷序列(逐时仿真)：真实峰值 + 负荷持续曲线 LDC
    let truePeakKw = null, loadDurationCurve = null;
    if (mode === 'engineering') {
      const series = [];
      months.forEach(mo => {
        const ld = this.buildLoadDay(mo.dailyKwh, load, region, mo.shape);
        for (let h = 0; h < 24; h++) series.push(ld[h]);
      });
      truePeakKw = Math.round(Math.max.apply(null, series));
      const sorted = series.slice().sort((a, b) => b - a);
      const N = 240;                                  // 下采样到 240 点用于绘图
      loadDurationCurve = [];
      for (let i = 0; i < N; i++) loadDurationCurve.push(Math.round(sorted[Math.floor(i * (sorted.length - 1) / (N - 1))]));
      if (!load.peakKw && truePeakKw) peakKw = truePeakKw;   // 工程版用 8760 真实峰值
    }

    // ---------- 基准能耗成本（无任何投资·纯电网） ----------
    let baselineEnergyCost = 0;
    months.forEach(mo => {
      const ld = this.buildLoadDay(mo.dailyKwh, load, region, mo.shape);
      let dayCost = 0;
      for (let h = 0; h < 24; h++) dayCost += ld[h] * this.priceAt(region, h).price;
      baselineEnergyCost += dayCost * mo.dayCount;
    });
    const baselineBasic = this.basicFee(peakKw, transformerKVA, region, basicFeeMode);
    const baselineAnnualCost = baselineEnergyCost + baselineBasic.fee;

    // ---------- 储能削峰后的最大需量与基本电费 ----------
    const demandMgmt = sel.storage && cfg.strategy && cfg.strategy.indexOf('demand') >= 0;
    const storageDemandCut = demandMgmt ? Math.min(cfg.storage.powerKw || 0, peakKw * 0.4) : 0;
    const withMaxDemand = Math.max(0, peakKw - storageDemandCut);
    const withBasic = this.basicFee(withMaxDemand, transformerKVA, region, basicFeeMode);

    // 等效发电量(kWh/kW·年)：可研模式下由 PvModel 提供，否则用地区缺省
    const pvYieldEff = cfg.pvYieldEff || region.pvYield;

    // ---------- 逐年模拟 ----------
    const annualNet = [];
    const omByYear = [];
    const energyByYear = [];
    const revenueByYear = [];        // 营业收入(电费节省+上网+充电+柴发调峰)
    const replacementByYear = [];    // 设备更换现金流出(储能等)
    const storeThroughputByYear = [];// 储能逐年放电量(用于 SOH/LCOS)
    let totalPvGen = 0, totalCarbonCut = 0, totalStoreThroughput = 0;

    // 充电桩、柴发年值（首年，后续保持稳定）
    const chg = sel.charger ? this.chargerYear(cfg.charger, region) : null;
    const dsl = sel.diesel ? this.dieselYear(cfg.diesel, region) : null;

    for (let y = 0; y < years; y++) {
      // 光伏衰减系数
      let pvFactor = 1;
      if (sel.pv) {
        pvFactor = (y === 0) ? (1 - cfg.pv.degradationY1)
                             : (1 - cfg.pv.degradationY1) * Math.pow(1 - cfg.pv.degradation, y);
      }
      // 储能容量衰减
      let storeForYear = null;
      if (sel.storage) {
        const cap = cfg.storage.capacityKwh * Math.pow(1 - cfg.storage.degradation, y);
        storeForYear = Object.assign({}, cfg.storage, { capacityKwh: cap });
      }

      let yearGridCost = 0, yearExport = 0, yearPvSelf = 0, yearPvExport = 0, yearThroughput = 0;

      months.forEach(mo => {
        const loadDay = this.buildLoadDay(mo.dailyKwh, load, region, mo.shape);
        const pvDay = sel.pv ? this.buildPvDay(cfg.pv.capacityKw, region, pvFactor, mo.monthFactor, pvYieldEff)
                             : new Array(24).fill(0);
        const demandCap = demandMgmt ? (peakKw * 0.75) : null;
        const d = this.dispatchDay({
          loadDay, pvDay, region,
          storage: storeForYear,
          strategy: cfg.dispatchMode || 'arbitrage',
          demandCap
        });
        yearGridCost += d.cost * mo.dayCount;
        yearExport += d.exportRevenue * mo.dayCount;
        yearPvSelf += d.pvSelfUse * mo.dayCount;
        yearPvExport += d.pvExport * mo.dayCount;
        yearThroughput += d.storeThroughput * mo.dayCount;
      });

      // 与系统下的总电费 = 电度电费 + 削峰后基本电费
      const energyCostWithSystem = yearGridCost + withBasic.fee;

      // 运维
      let om = 0;
      if (sel.pv) om += cfg.pv.capacityKw * cfg.pv.omPerKwYear;
      if (sel.storage) om += cfg.storage.capacityKwh * cfg.storage.omPerKwhYear;
      if (sel.charger) om += chg.om;
      if (sel.diesel) om += dsl.om;

      // 营业收入 = 电费节省 + 上网收入 + 充电桩净收入 + 柴发调峰价值
      const electricitySaving = baselineAnnualCost - energyCostWithSystem;
      let revenue = electricitySaving + yearExport;
      if (sel.charger) revenue += chg.net;
      if (sel.diesel) revenue += dsl.peakShaveValue;

      // 储能到寿命需更换（第 lifeYears 年末计入更换成本）
      let replacement = 0;
      if (sel.storage && cfg.storage.lifeYears && (y + 1) === cfg.storage.lifeYears && (y + 1) < years) {
        replacement = cfg.storage.capacityKwh * cfg.storage.capexPerWh * 1000 * 0.6; // 电芯降价，按 60%
      }
      let net = revenue - om - replacement;
      revenueByYear.push(revenue);
      replacementByYear.push(replacement);

      annualNet.push(net);
      omByYear.push(om);
      // 供电量（用于 LCOE）：自用光伏+储能放电+负荷被满足部分
      energyByYear.push(yearPvSelf + yearThroughput);

      storeThroughputByYear.push(yearThroughput);
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
      revenueByYear, replacementByYear, generationByYear: energyByYear,
      storeThroughputByYear,
      finance: fin,
      env: {
        carbonCut: totalCarbonCut,    // tCO2 全周期
        pvGenTotal: totalPvGen,
        storeThroughput: totalStoreThroughput
      },
      load: {
        annualKwh, peakKw, transformerKVA,
        basicFeeMode,
        baselineBasis: baselineBasic.basis,   // 基准基本电费计费依据
        withBasis: withBasic.basis,
        baselineBasicFee: baselineBasic.fee,
        withBasicFee: withBasic.fee,
        demandCut: storageDemandCut,
        truePeakKw, loadDurationCurve
      },
      detail: { charger: chg, diesel: dsl, loadDay: repLoadDay, peakKw }
    };
  },

  _daysInMonth(m) {
    return [31,28,31,30,31,30,31,31,30,31,30,31][m];
  }
};

if (typeof module !== 'undefined') module.exports = { Engine };
