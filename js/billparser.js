/**
 * billparser.js — 电费单解析与"电费单 × 负荷表"交叉校准（核心算法修正）
 *
 * 设计理念：电费单是计费"真值"。负荷表给曲线形状，电费单给真实的
 * 分时电量(尖/峰/平/谷)、最大需量、变压器容量、基本/电度/总电费、功率因数。
 * 用电费单校准负荷画像，再与负荷表交叉校验、提示差异。
 *
 * 提供：
 *   parseText(text)         中文电费单文本 → 结构化字段（正则启发式）
 *   normalize(obj)          把外部(大模型/录入)字段规整为标准 Bill
 *   calibrate(bills, load)  多张电费单 + 负荷表 → 校准后的负荷配置 + 交叉校验
 *
 * 零依赖、DOM-free，可在 vm 测试。
 */

const BillParser = {
  /** 中文电费单纯文本 → 结构化（尽力而为，识别失败的字段留空） */
  parseText(text) {
    const t = String(text || '').replace(/，/g, ',').replace(/：/g, ':');
    const num = (re) => {
      const m = t.match(re);
      if (!m) return null;
      const v = parseFloat(m[1].replace(/,/g, ''));
      return isFinite(v) ? v : null;
    };
    const bill = {
      month: null,
      energy: { sharp: null, peak: null, flat: null, valley: null, total: null },
      maxDemand: null, transformerKVA: null,
      basicFee: null, energyFee: null, totalFee: null, powerFactor: null
    };

    // 计费年月
    const ym = t.match(/(20\d{2})\s*[-/年.]\s*(\d{1,2})\s*月?/);
    if (ym) bill.month = Math.min(12, Math.max(1, parseInt(ym[2], 10)));

    // 分时电量（兼容多种叫法），单位常为 度/kWh
    bill.energy.sharp  = num(/(?:尖峰?|尖端)(?:时段)?(?:用)?电量[:\s]*([\d,\.]+)/);
    bill.energy.peak   = num(/(?:高峰|峰段|峰)(?:时段)?(?:用)?电量[:\s]*([\d,\.]+)/);
    bill.energy.flat   = num(/(?:平段|平)(?:时段)?(?:用)?电量[:\s]*([\d,\.]+)/);
    bill.energy.valley = num(/(?:低谷|谷段|谷)(?:时段)?(?:用)?电量[:\s]*([\d,\.]+)/);
    bill.energy.total  = num(/(?:总用?电量|合计电量|用电量合计|总电量)[:\s]*([\d,\.]+)/);

    // 最大需量(kW)、变压器/受电容量(kVA)
    bill.maxDemand     = num(/(?:最大需量|实际需量|计费需量|需量)[:\s]*([\d,\.]+)/);
    bill.transformerKVA= num(/(?:受电容量|变压器容量|合同容量|用电容量)[:\s]*([\d,\.]+)/);

    // 费用
    bill.basicFee  = num(/(?:基本电费)[:\s]*([\d,\.]+)/);
    bill.energyFee = num(/(?:电度电费|电量电费)[:\s]*([\d,\.]+)/);
    bill.totalFee  = num(/(?:电费合计|应收electricity?|应收电费|合计电费|总电费|本月电费|费用合计)[:\s]*([\d,\.]+)/);

    // 功率因数 / 力率
    let pf = num(/(?:功率因数|力率)[:\s]*([\d,\.]+)/);
    if (pf != null && pf > 1) pf = pf / 100;     // 兼容 "95" 写法
    bill.powerFactor = pf;

    return this.normalize(bill);
  },

  /** 规整：补总电量、综合电价、可信度 */
  normalize(b) {
    const e = b.energy || {};
    const parts = ['sharp', 'peak', 'flat', 'valley'].map(k => e[k] || 0);
    const sum = parts.reduce((a, c) => a + c, 0);
    if (!e.total && sum > 0) e.total = sum;
    b.energy = e;
    b.avgPrice = (b.totalFee && e.total) ? +(b.totalFee / e.total).toFixed(4) : null;
    // 识别到的关键字段数（用于提示完整度）
    b.fields = ['energy.total', 'maxDemand', 'transformerKVA', 'totalFee']
      .filter(p => this._get(b, p) != null).length;
    return b;
  },

  _get(o, path) { return path.split('.').reduce((a, k) => (a ? a[k] : null), o); },

  /** 扁平字段(大模型/录入表) → 标准 Bill。字段：month,sharp,peak,flat,valley,total,
   *  maxDemand,transformerKVA,basicFee,energyFee,totalFee,powerFactor */
  fromFields(o) {
    o = o || {};
    const n = v => { const x = parseFloat(v); return isFinite(x) ? x : null; };
    let pf = n(o.powerFactor); if (pf != null && pf > 1) pf = pf / 100;
    return this.normalize({
      month: o.month ? Math.min(12, Math.max(1, parseInt(o.month, 10))) : null,
      energy: { sharp: n(o.sharp), peak: n(o.peak), flat: n(o.flat), valley: n(o.valley), total: n(o.total) },
      maxDemand: n(o.maxDemand), transformerKVA: n(o.transformerKVA),
      basicFee: n(o.basicFee), energyFee: n(o.energyFee), totalFee: n(o.totalFee), powerFactor: pf
    });
  },

  /**
   * 用电费单校准负荷配置，并与负荷表交叉校验
   * @param {Bill[]} bills 一张或多张（多张=多月）
   * @param {object} load  当前负荷配置 { monthly[12], peakKw, transformerKVA, ... }
   * @returns { calibrated:{monthly,tou,dataTier,peakKw,transformerKVA,basicFeeMode}, notes[], crossCheck }
   */
  calibrate(bills, load) {
    bills = (bills || []).filter(Boolean);
    const notes = [];
    if (!bills.length) return { calibrated: null, notes: ['无电费单数据'], crossCheck: null };

    // 1) 各月电量（按电费单月份归位；缺失月用均值补全）
    const monthly = (load && load.monthly) ? load.monthly.slice() : new Array(12).fill(0);
    const monthHas = new Array(12).fill(false);
    bills.forEach(b => {
      if (b.month && b.energy.total) { monthly[b.month - 1] = b.energy.total; monthHas[b.month - 1] = true; }
    });
    const present = monthly.filter((_, i) => monthHas[i]);
    if (present.length) {
      const avg = present.reduce((a, c) => a + c, 0) / present.length;
      for (let i = 0; i < 12; i++) if (!monthHas[i]) monthly[i] = Math.round(avg);
      notes.push(`已按电费单设定 ${present.length} 个月电量` + (present.length < 12 ? '，其余月用均值补全' : '（全年完整）'));
    } else if (bills[0].energy.total) {
      // 无月份信息：单张按典型月 ×12
      for (let i = 0; i < 12; i++) monthly[i] = bills[0].energy.total;
      notes.push('电费单未含月份，按单月电量推算全年（建议提供多月电费单）');
    }

    // 2) 分时电量占比 → tou
    const agg = { sharp: 0, peak: 0, flat: 0, valley: 0 };
    let touOk = false;
    bills.forEach(b => {
      ['sharp', 'peak', 'flat', 'valley'].forEach(k => { if (b.energy[k]) { agg[k] += b.energy[k]; touOk = true; } });
    });
    let tou = null, dataTier = (load && load.dataTier) || 'template';
    if (touOk) {
      const s = agg.sharp + agg.peak + agg.flat + agg.valley || 1;
      tou = { sharp: +(agg.sharp / s).toFixed(3), peak: +(agg.peak / s).toFixed(3),
              flat: +(agg.flat / s).toFixed(3), valley: +(agg.valley / s).toFixed(3) };
      dataTier = 'tou';
      notes.push(`已按电费单分时电量设定占比：尖${(tou.sharp*100).toFixed(0)}/峰${(tou.peak*100).toFixed(0)}/平${(tou.flat*100).toFixed(0)}/谷${(tou.valley*100).toFixed(0)}%`);
    }

    // 3) 最大需量、变压器容量、基本电费计费方式
    const demands = bills.map(b => b.maxDemand).filter(v => v);
    let peakKw = demands.length ? Math.max.apply(null, demands) : (load ? load.peakKw : null);
    const kvas = bills.map(b => b.transformerKVA).filter(v => v);
    const transformerKVA = kvas.length ? Math.max.apply(null, kvas) : (load ? load.transformerKVA : null);
    if (transformerKVA) notes.push(`已确定变压器（受电）容量 ${Math.round(transformerKVA)} kVA（储能削峰将据此配置）`);
    else notes.push('⚠ 未识别到变压器容量，请在电费单或表单中补充（影响储能削峰与基本电费）');

    // —— 负荷表 ↔ 电费单 倍率匹配（互感器倍率自动反算） ——
    let multiplier = null;
    const billAnnual = monthly.reduce((a, c) => a + (c || 0), 0);
    if (load && load.measuredAnnual && billAnnual > 0) {
      multiplier = +(billAnnual / load.measuredAnnual).toFixed(2);
      if (Math.abs(Math.log(multiplier)) > Math.log(1.5)) {
        notes.push(`负荷表实测电量与电费单相差约 ×${multiplier}（疑似互感器倍率），已自动按电费单口径校正`);
      } else {
        notes.push(`负荷表实测电量与电费单倍率 ×${multiplier}（基本一致）`);
      }
    }
    // 电费单无最大需量时，用负荷表峰值 × 倍率 反推
    if (!demands.length && load && load.measuredPeakKw) {
      peakKw = Math.round(load.measuredPeakKw * (multiplier || 1));
      notes.push(`电费单未含最大需量，按负荷表峰值×倍率反推 ${peakKw} kW`);
    } else if (demands.length) {
      notes.push(`已按电费单设定最大需量 ${Math.round(peakKw)} kW`);
    }

    // 基本电费计费方式：若同时有基本电费与最大需量，判断按需量还是按容量
    let basicFeeMode = (load && load.basicFeeMode) || 'auto';
    const b0 = bills.find(b => b.basicFee);
    if (b0 && b0.basicFee) {
      if (b0.maxDemand && transformerKVA) {
        const perDemand = b0.basicFee / b0.maxDemand;     // 元/kW/月
        const perCap = b0.basicFee / transformerKVA;      // 元/kVA/月
        // 需量电价通常 30~50，容量电价通常 20~35；这里粗判：更接近哪种典型
        basicFeeMode = Math.abs(perDemand - 40) <= Math.abs(perCap - 28) ? 'demand' : 'capacity';
        notes.push(`基本电费 ${Math.round(b0.basicFee)} 元 ⇒ 判定按「${basicFeeMode === 'demand' ? '最大需量' : '变压器容量'}」计费`);
      }
    }

    // 4) 交叉校验：电费单综合电价 / 与负荷表峰值
    const crossCheck = this._crossCheck(bills, load, peakKw);
    crossCheck.warnings.forEach(w => notes.push('⚠ ' + w));

    return {
      calibrated: { monthly, tou, dataTier, peakKw, transformerKVA, basicFeeMode, multiplier },
      notes, crossCheck
    };
  },

  _crossCheck(bills, load, peakKw) {
    const warnings = [];
    const out = { warnings };
    // 负荷表 15 分钟峰值 vs 电费单最大需量
    if (load && load.measuredPeakKw && peakKw) {
      const diff = (load.measuredPeakKw - peakKw) / peakKw;
      out.peakDiff = +(diff * 100).toFixed(1);
      if (Math.abs(diff) > 0.15)
        warnings.push(`负荷表峰值 ${Math.round(load.measuredPeakKw)}kW 与电费单需量 ${Math.round(peakKw)}kW 相差 ${(diff*100).toFixed(0)}%，已以电费单为准（请核对计量口径）`);
    }
    // 负荷表年电量 vs 电费单年电量
    const billAnnual = bills.reduce((a, b) => a + (b.energy.total || 0), 0);
    if (load && load.measuredAnnual && billAnnual > 0 && bills.length >= 6) {
      const diff = (load.measuredAnnual - billAnnual) / billAnnual;
      out.energyDiff = +(diff * 100).toFixed(1);
      if (Math.abs(diff) > 0.1)
        warnings.push(`负荷表年电量与电费单相差 ${(diff*100).toFixed(0)}%，已以电费单为准`);
    }
    out.avgPrice = (() => {
      const tf = bills.reduce((a, b) => a + (b.totalFee || 0), 0);
      const te = bills.reduce((a, b) => a + (b.energy.total || 0), 0);
      return te > 0 && tf > 0 ? +(tf / te).toFixed(4) : null;
    })();
    return out;
  }
};

if (typeof module !== 'undefined') module.exports = { BillParser };
