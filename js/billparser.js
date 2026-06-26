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
    if (this._isGuangwang(text)) return this.parseGuangwang(text);
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

  // 是否南网版式（英文锚点对乱码/干净文本都有效）
  _isGuangwang(text) {
    return /南方电网|Electricity Bill Information|Electricity Consumption Details|电度电费|输配电费/.test(String(text || ''));
  },

  /**
   * 南网电费单解析（规则）。主输入为 pdf.js 干净文本（按中文标签锚定）；
   * 标签缺失/乱码时退化为"重复电量值 + 容量×单价"数字兜底。
   */
  parseGuangwang(text) {
    let t = String(text || '').replace(/[，（）：]/g, c => ({ '，': ',', '（': '(', '）': ')', '：': ':' }[c]));
    // PDF 零依赖提取常把数字拆成"7 8 5 4 0 . 0 0"，合并空格分隔的单数字串（对干净文本无副作用）
    t = t.replace(/\d(?:\s+\d){1,}(?:\s*\.\s*\d(?:\s+\d)*)?/g, s => s.replace(/\s+/g, ''));
    const grab = re => { const m = t.match(re); return m ? parseFloat(m[1].replace(/,/g, '')) : null; };
    const seg = name => grab(new RegExp('电度电费\\s*\\(\\s*' + name + '\\s*\\)[^\\d-]*([\\d,]+\\.\\d{2})'));

    let energy = { sharp: seg('尖'), peak: seg('峰'), flat: seg('平'), valley: seg('谷'), total: null };
    let transformerKVA = grab(/受电容量[^\d]*([\d,]+(?:\.\d+)?)/) || grab(/容量电费[^\d-]*([\d,]+\.\d{2})/);
    let maxDemand = grab(/需量电费[^\d-]*([\d,]+\.\d{2})/) || grab(/最大需量[^\d]*([\d,]+(?:\.\d+)?)/);
    const totalFee = grab(/(?:应收电费合计|电费合计|合计电费|本月应交电费|总电费)[^\d-]*([\d,]+\.\d{2})/);

    let month = null;
    const dm = t.match(/(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/);
    if (dm) month = parseInt(dm[2], 10);

    // 计费方式：有容量电费且无需量 → 按容量；有需量电费 → 按需量
    let basicFeeBasis = null;
    if (/容量电费/.test(t) && !maxDemand) basicFeeBasis = 'capacity';
    else if (maxDemand || /需量电费/.test(t)) basicFeeBasis = 'demand';

    // 数字兜底：分时电量（4 个重复电量值，尖默认 0）
    if (!(energy.peak || energy.flat || energy.valley)) {
      const seg2 = this._gwNumericSegments(t);
      if (seg2) energy = Object.assign(energy, seg2);
    }
    if (!transformerKVA) transformerKVA = this._gwCapacity(t);

    const bill = this.normalize({ month, energy, maxDemand, transformerKVA, basicFee: null, energyFee: null, totalFee, powerFactor: null });
    bill.basicFeeBasis = basicFeeBasis;
    bill.source = 'guangwang';
    return bill;
  },

  // 数字兜底：取重复≥3 次的非零电量值（按首次出现）→ 峰/平/谷；尖默认 0
  _gwNumericSegments(t) {
    const re = /\b(\d{3,7})\.00\b/g; let m;
    const order = [], cnt = {};
    while ((m = re.exec(t))) {
      const v = parseInt(m[1], 10);
      if (v <= 0) continue;
      if (cnt[v] === undefined) { cnt[v] = 0; order.push(v); }
      cnt[v]++;
    }
    const rep = order.filter(v => cnt[v] >= 3);
    if (rep.length >= 3) return { sharp: 0, peak: rep[0], flat: rep[1], valley: rep[2] };
    return null;
  },

  // 数字兜底：容量×单价=电费 → 取容量(kVA)
  _gwCapacity(t) {
    const re = /(\d{3,6})\.00\s+(\d{1,3}\.\d{2})\b/g; let m;
    while ((m = re.exec(t))) {
      const cap = parseInt(m[1], 10), rate = parseFloat(m[2]);
      if (cap >= 100 && rate >= 10 && rate <= 60 && cap * rate > 10000) return cap;
    }
    return null;
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
    const n = v => { const x = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(x) ? x : null; };
    let pf = n(o.powerFactor); if (pf != null && pf > 1) pf = pf / 100;
    return this.normalize({
      month: this._month(o.month),
      energy: { sharp: n(o.sharp), peak: n(o.peak), flat: n(o.flat), valley: n(o.valley), total: n(o.total) },
      maxDemand: n(o.maxDemand), transformerKVA: n(o.transformerKVA),
      basicFee: n(o.basicFee), energyFee: n(o.energyFee), totalFee: n(o.totalFee), powerFactor: pf
    });
  },

  _month(v) {
    if (v == null || v === '') return null;
    const s = String(v);
    const m = s.match(/(\d{1,2})\s*月/) || s.match(/^\s*(\d{1,2})\s*$/);
    const mm = m ? parseInt(m[1], 10) : parseInt(s, 10);
    return (mm >= 1 && mm <= 12) ? mm : null;
  },

  /**
   * 表格解析：CSV/Excel 模板（一行 = 一张/一月电费单）→ Bill[]
   * 按表头关键字映射列，无表头则无法识别。
   * @param {string[][]} rows 二维数组
   */
  parseTable(rows) {
    rows = (rows || []).filter(r => r && r.some(c => String(c == null ? '' : c).trim().length))
                       .map(r => r.map(c => String(c == null ? '' : c).trim()));
    if (rows.length < 2) return [];
    const header = rows[0];
    const idx = {};
    header.forEach((h, i) => {
      if (/尖/.test(h)) idx.sharp = i;
      else if (/(高峰|峰段)|(^|[^尖平低])峰/.test(h)) idx.peak = i;
      else if (/平段|平/.test(h)) idx.flat = i;
      else if (/低谷|谷段|谷/.test(h)) idx.valley = i;
      else if (/总.*电量|用电量|总电量|电量合计/.test(h)) idx.total = i;
      else if (/需量/.test(h)) idx.maxDemand = i;
      else if (/容量|变压器|受电/.test(h)) idx.transformerKVA = i;
      else if (/基本电费/.test(h)) idx.basicFee = i;
      else if (/电度|电量电费/.test(h)) idx.energyFee = i;
      else if (/合计|总电费|应收/.test(h)) idx.totalFee = i;
      else if (/月/.test(h)) idx.month = i;
      else if (/功率因数|力率/.test(h)) idx.powerFactor = i;
    });
    // 至少要识别到电量或需量列才算有效模板
    if (idx.total == null && idx.peak == null && idx.maxDemand == null) return [];
    const bills = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const get = k => (idx[k] != null ? row[idx[k]] : undefined);
      const b = this.fromFields({
        month: get('month'), sharp: get('sharp'), peak: get('peak'), flat: get('flat'),
        valley: get('valley'), total: get('total'), maxDemand: get('maxDemand'),
        transformerKVA: get('transformerKVA'), basicFee: get('basicFee'),
        energyFee: get('energyFee'), totalFee: get('totalFee'), powerFactor: get('powerFactor')
      });
      if (b.energy.total || b.maxDemand || b.energy.peak) bills.push(b);
    }
    return bills;
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

    // 基本电费计费方式
    let basicFeeMode = (load && load.basicFeeMode) || 'auto';
    // 优先采用电费单明确的计费方式（如南网"容量电费/需量电费"）
    const basisBill = bills.find(b => b.basicFeeBasis);
    if (basisBill) {
      basicFeeMode = basisBill.basicFeeBasis;
      notes.push(`按电费单计费方式：${basicFeeMode === 'capacity' ? '按变压器容量' : '按最大需量'}`);
    }
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
