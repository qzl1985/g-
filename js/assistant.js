/**
 * assistant.js — 对话式 AI 助手
 *
 * 用大白话描述需求（如"我厂房 8000 平，月电费 30 万，三班倒，想配光伏加储能"），
 * 助手解析关键参数 → 调用预测与优化 → 给出可解释的推荐方案。
 *
 * 这里内置的是「规则 + 语义抽取」引擎，零依赖、可离线运行；
 * 预留 callLLM 钩子，接入大模型 API 后可升级为更自然的对话（见 README）。
 */

const Assistant = {
  /**
   * 解析中文自然语言，抽取测算所需参数
   * @returns { regionKey?, profile?, devices{}, annualKwh?, monthlyBill?, peakKw?, areaM2?, budget?, objective? }
   */
  parse(text) {
    const t = text.replace(/，/g, ',').replace(/。/g, '.');
    const out = { devices: {} };

    // —— 设备识别 ——
    if (/光伏|太阳能|组件|屋顶发电/.test(text)) out.devices.pv = true;
    if (/储能|电池|蓄电|削峰填谷|峰谷套利/.test(text)) out.devices.storage = true;
    if (/充电桩|充电站|快充|充电/.test(text)) out.devices.charger = true;
    if (/柴油|柴发|发电机|备用电源|油机/.test(text)) out.devices.diesel = true;
    // 未明确则默认光伏+储能
    if (!Object.keys(out.devices).length) { out.devices.pv = true; out.devices.storage = true; }

    // —— 地区识别 ——
    if (/华东|江浙|上海|江苏|浙江|长三角/.test(text)) out.regionKey = 'cn_ci_east';
    else if (/华北|京津冀|北京|天津|河北|山东/.test(text)) out.regionKey = 'cn_ci_north';
    else if (/华南|广东|深圳|广州|珠三角|南方/.test(text)) out.regionKey = 'cn_ci_south';
    else if (/户用|居民|家庭|别墅|自建房/.test(text)) out.regionKey = 'cn_residential';
    else if (/海外|欧洲|国外/.test(text)) out.regionKey = 'overseas_eu';

    // —— 负荷类型 ——
    if (/三班|连续生产|24小时|两班倒.*夜/.test(text)) out.profile = 'three_shift';
    else if (/两班|双班/.test(text)) out.profile = 'double_shift';
    else if (/单班|白班|白天/.test(text)) out.profile = 'single_shift';
    else if (/商场|写字楼|楼宇|商业|办公/.test(text)) out.profile = 'commercial';
    else if (/居民|家庭|户用/.test(text)) out.profile = 'residential';

    // —— 数字抽取（带单位）——
    out.monthlyBill = this._num(text, /(?:月电费|月均电费|每月电费|电费)[约为是:\s]*([\d.]+)\s*(万|万元|元)?/, '万');
    out.annualKwh = this._num(text, /(?:年用电|年耗电|年用电量|用电量)[约为是:\s]*([\d.]+)\s*(万度|万kwh|万千瓦时|度|kwh|千瓦时)?/i, '万度');
    out.peakKw = this._num(text, /(?:峰值|最大负荷|装机|变压器|容量)[约为是:\s]*([\d.]+)\s*(兆瓦|mw|千瓦|kw)?/i, 'kw');
    out.areaM2 = this._num(text, /(?:厂房|屋顶|面积|场地|可用面积)[约为是:\s]*([\d.]+)\s*(万平|万平方米|平米|平方米|平|㎡|m2)?/i, '平');
    out.budget = this._num(text, /(?:预算|投资|资金)[约为是:\s]*([\d.]+)\s*(亿|亿元|万|万元)?/, '万');

    // —— 目标 ——
    if (/回本|回收|越快/.test(text)) out.objective = 'minPayback';
    else if (/收益率|irr|回报率/i.test(text)) out.objective = 'maxIrr';
    else out.objective = 'maxNpv';

    return out;
  },

  /**
   * 端到端：文本 → 推荐方案
   * @param {string} text 用户自然语言
   * @param {object} fallback 缺省值（当前界面配置），用于补全未提及参数
   * @returns { reply, parsed, recommendation }
   */
  recommend(text, fallback) {
    const parsed = this.parse(text);
    const regionKey = parsed.regionKey || fallback.regionKey || 'cn_ci_east';
    const profile = parsed.profile || fallback.load.profile || 'double_shift';

    // 负荷画像
    const load = Forecast.buildLoadProfile({
      monthlyBill: parsed.monthlyBill,
      annualKwh: parsed.annualKwh,
      peakKw: parsed.peakKw,
      profile, regionKey
    });

    if (!load.annualKwh) {
      return {
        parsed,
        reply: '我需要一点用电信息才能测算：请告诉我大致的【月电费】或【年用电量】或【峰值负荷/变压器容量】其中之一。\n' +
               '例如："华东，三班倒工厂，月电费 30 万，厂房 8000 平，想配光伏加储能"。'
      };
    }

    // 组装基础配置（用默认设备参数）
    const base = App.buildConfig({
      regionKey,
      selected: { ...parsed.devices },
      load: { annualKwh: load.annualKwh, peakKw: load.peakKw, profile },
      mode: 'simplified'
    });

    // 优化容量
    const cons = {
      budget: parsed.budget,
      areaM2: parsed.areaM2,
      objective: parsed.objective
    };
    const opt = Optimizer.optimizeCapacity(base, cons);

    // 生成回复
    const dvNames = Object.keys(parsed.devices).filter(k => parsed.devices[k])
      .map(k => ({ pv: '光伏', storage: '储能', charger: '充电桩', diesel: '柴油发电机' }[k])).join(' + ');
    let reply = `已为你测算（${REGIONS[regionKey].name}，${LOAD_PROFILES[profile].name}）：\n`;
    reply += `· 年用电量约 ${this._fmt(load.annualKwh)} kWh（${load.source}），峰值约 ${this._fmt(load.peakKw)} kW\n`;
    reply += `· 拟配置：${dvNames}\n\n`;
    reply += opt.explain;
    reply += '\n\n你可以点击下方"应用此方案"把参数填入表单，或继续追加条件（预算、面积、目标）让我重算。';

    return { parsed, load, recommendation: opt, reply };
  },

  /**
   * LLM 升级钩子（可选）。配置 API Key 后可替换 parse/recommend 的自然语言层。
   * 默认未启用，返回 null，由规则引擎兜底。
   */
  async callLLM(/* text, context */) {
    return null;
  },

  // -------- 内部 --------
  /**
   * 抽取数字并按单位归一化
   * @param defaultUnit 当未写单位时的默认单位
   */
  _num(text, regex, defaultUnit) {
    const m = text.match(regex);
    if (!m) return undefined;
    let val = parseFloat(m[1]);
    if (isNaN(val)) return undefined;
    const unit = (m[2] || defaultUnit).toLowerCase();
    // 电费 → 元
    if (/亿/.test(unit)) return val * 1e8;
    if (/万/.test(unit)) {
      if (/度|kwh|千瓦时/.test(unit)) return val * 1e4;       // 万度 → kWh
      if (/平/.test(unit)) return val * 1e4;                  // 万平 → m²
      return val * 1e4;                                       // 万元 → 元
    }
    if (/兆瓦|mw/.test(unit)) return val * 1000;              // MW → kW
    // 其余按原值（元 / 度 / kw / 平）
    return val;
  },

  _fmt(n) { return Math.round(n).toLocaleString('zh-CN'); }
};

if (typeof module !== 'undefined') module.exports = { Assistant };
