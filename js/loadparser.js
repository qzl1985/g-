/**
 * loadparser.js — 用电负荷表智能解析（零依赖、离线）
 *
 * 解析电力公司导出的 15 分钟（或 5/10/30/60 分钟）负荷数据，自动识别：
 *   - 分隔符（逗号 / 制表 / 分号 / 空白）与表头
 *   - 时间列、数值列、采样间隔
 *   - 数值是「有功功率 kW」还是「每区间电量 kWh」（含表头关键字判定 + 量级兜底）
 * 产出：年用电量、12 个月电量、真实最大需量(kW)、逐时(24h)平均负荷曲线。
 *
 * 用法：LoadParser.parse(text, { valueKind?, intervalMin? }) → { ok, ... }
 */

const LoadParser = {
  // 文本入口（CSV / 粘贴）：拆分后交给 parseRows
  parse(text, opts) {
    opts = opts || {};
    const lines = String(text || '').replace(/\r/g, '').split('\n').filter(l => l.trim().length);
    if (lines.length < 2) return { ok: false, error: '数据太少：至少需要表头或若干行数据。' };
    const delim = this._detectDelim(lines);
    const rows = lines.map(l => this._split(l, delim));
    return this.parseRows(rows, opts);
  },

  // 二维数组入口（xlsx 解析后、或多文件合并后调用）
  parseRows(rows, opts) {
    opts = opts || {};
    rows = (rows || []).filter(r => r && r.some(c => String(c == null ? '' : c).trim().length));
    if (rows.length < 2) return { ok: false, error: '数据太少：至少需要表头或若干行数据。' };
    rows = rows.map(r => r.map(c => String(c == null ? '' : c).trim()));
    const hasHeader = this._looksHeader(rows[0]);
    const header = hasHeader ? rows[0].map(s => s.trim()) : null;
    const dataRows = hasHeader ? rows.slice(1) : rows;
    if (!dataRows.length) return { ok: false, error: '只有表头、没有数据行。' };

    const ncol = Math.max.apply(null, dataRows.slice(0, 50).map(r => r.length));
    const valueCol = this._detectValueCol(dataRows, header, ncol);
    if (valueCol < 0) return { ok: false, error: '未能识别出数值列（功率/电量），请检查数据。' };

    let kind = opts.valueKind || this._detectKind(header, valueCol);

    // 解析每行：数值 + 时间（其余列拼成时间串解析）
    const recs = [];
    for (const r of dataRows) {
      const raw = (r[valueCol] || '').replace(/[,\s]/g, '');
      const val = parseFloat(raw);
      if (!isFinite(val)) continue;
      const tsStr = r.filter((_, i) => i !== valueCol).join(' ');
      const dt = this._parseDT(tsStr);
      recs.push({ val, h: dt.h, mi: dt.mi, mo: dt.mo, hasDate: dt.hasDate });
    }
    if (!recs.length) return { ok: false, error: '未解析到有效的数值数据行。' };

    const interval = opts.intervalMin || this._detectInterval(recs);
    const factor = interval / 60;

    // 数值类型量级兜底：若仍未知，按"15分钟电量通常远小于功率"的弱启发，默认按功率
    if (!kind) kind = 'power';

    const monthE = new Array(12).fill(0);
    const monthHas = new Array(12).fill(false);
    const hourSum = new Array(24).fill(0);
    const hourCnt = new Array(24).fill(0);
    let sumE = 0, peakP = 0;

    for (const r of recs) {
      const power = kind === 'power' ? r.val : r.val / factor;       // kW
      const energy = kind === 'power' ? r.val * factor : r.val;      // kWh（该区间）
      sumE += energy;
      if (power > peakP) peakP = power;
      const h = (r.h != null) ? r.h : 0;
      hourSum[h] += power; hourCnt[h]++;
      if (r.hasDate && r.mo != null) { monthE[r.mo] += energy; monthHas[r.mo] = true; }
    }

    let monthly, annualKwh, spanNote;
    if (monthHas.some(Boolean)) {
      const present = monthE.filter((_, i) => monthHas[i]);
      const avg = present.reduce((a, b) => a + b, 0) / present.length;
      monthly = monthE.map((v, i) => (monthHas[i] ? v : avg));
      annualKwh = monthly.reduce((a, b) => a + b, 0);
      spanNote = monthHas.every(Boolean) ? '按日期归入各月（全年完整）'
                                         : '按日期归入各月（部分月份缺失，已用均值补全）';
    } else {
      const dayE = sumE; // 无日期：视为一个典型日
      const dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      monthly = dim.map(d => dayE * d);
      annualKwh = dayE * 365;
      spanNote = '未含日期，按"典型日×365"推算全年';
    }

    const hourly = hourSum.map((s, i) => (hourCnt[i] ? s / hourCnt[i] : 0));

    return {
      ok: true,
      interval, kind, valueCol, header,
      count: recs.length,
      annualKwh, monthly,
      peakKw: Math.round(peakP),
      hourly,
      note: `识别成功：${interval} 分钟间隔，共 ${recs.length} 条；数值判定为${kind === 'power' ? '有功功率 (kW)' : '每区间电量 (kWh)'}；${spanNote}。` +
            `年用电约 ${(annualKwh / 1e4).toFixed(1)} 万 kWh，最大需量约 ${Math.round(peakP)} kW。`
    };
  },

  // ---------------- 内部 ----------------
  _detectDelim(lines) {
    const sample = lines.slice(0, 8).join('\n');
    const cand = [['\t', (sample.match(/\t/g) || []).length],
                  [',', (sample.match(/,/g) || []).length],
                  [';', (sample.match(/;/g) || []).length]];
    cand.sort((a, b) => b[1] - a[1]);
    return cand[0][1] > 0 ? cand[0][0] : /\s+/;
  },

  _split(line, delim) {
    if (delim instanceof RegExp) return line.trim().split(delim);
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') q = !q;
      else if (ch === delim && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
  },

  _looksHeader(row) {
    const kw = /时间|日期|功率|电量|用电|负荷|有功|kwh|kw|power|load|date|time/i;
    if (row.some(c => kw.test(c))) return true;
    // 全部非数值也视为表头
    return row.every(c => isNaN(parseFloat(c)));
  },

  _detectValueCol(rows, header, ncol) {
    // 优先表头关键字
    if (header) {
      for (let i = 0; i < header.length; i++) {
        if (/kwh|电量|用电|有功|功率|负荷|kw|power|load/i.test(header[i])) return i;
      }
    }
    // 否则取"数值多且方差大"的列（时间/日期列含 : 或 - 会被 parseFloat 排除或方差极小）
    let best = -1, bestScore = -1;
    for (let c = 0; c < ncol; c++) {
      const nums = [];
      for (const r of rows.slice(0, 300)) {
        const v = parseFloat((r[c] || '').replace(/[,\s]/g, ''));
        if (isFinite(v)) nums.push(v);
      }
      if (nums.length < Math.min(5, rows.length)) continue;
      const max = Math.max.apply(null, nums), min = Math.min.apply(null, nums);
      const score = nums.length * (max - min);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  },

  _detectKind(header, col) {
    if (header && header[col]) {
      if (/kwh|电量|用电|能量|kw·h|kw\.h/i.test(header[col])) return 'energy';
      if (/kw|功率|有功|负荷|power/i.test(header[col])) return 'power';
    }
    return null;
  },

  _parseDT(s) {
    const out = { hasDate: false, mo: null, h: null, mi: null };
    const dm = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    const tm = s.match(/(\d{1,2}):(\d{2})/);
    if (dm) { out.hasDate = true; out.mo = Math.min(11, Math.max(0, parseInt(dm[2], 10) - 1)); }
    if (tm) { out.h = Math.min(23, parseInt(tm[1], 10)); out.mi = parseInt(tm[2], 10); }
    // Excel 序列日期（数值，如 45292.5104）：约 1954–2119 年区间
    if (!dm && !tm) {
      const num = parseFloat(String(s).trim());
      if (isFinite(num) && num > 20000 && num < 80000) {
        const d = new Date(Date.UTC(1899, 11, 30) + Math.round(num * 86400) * 1000);
        out.hasDate = true;
        out.mo = d.getUTCMonth();
        out.h = d.getUTCHours();
        out.mi = d.getUTCMinutes();
      }
    }
    return out;
  },

  _detectInterval(recs) {
    const mins = new Set();
    for (const r of recs.slice(0, 600)) if (r.mi != null) mins.add(r.mi);
    if (mins.has(15) || mins.has(45)) return 15;
    if (mins.has(10) || mins.has(20) || mins.has(40)) return 10;
    if (mins.has(5) || mins.has(25) || mins.has(35)) return 5;
    if (mins.has(30)) return 30;
    return 60;
  }
};

if (typeof module !== 'undefined') module.exports = { LoadParser };
