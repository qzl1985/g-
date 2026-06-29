/**
 * bom.js — 投资估算（分项）+ 主要设备材料清单 BOM（模块G）
 *
 * 由设备配置与造价生成可研口径的投资估算表：
 *   设备购置费 / 建筑安装费 / 其他费用(设计监理接入) / 基本预备费 / 建设期利息 → 动态总投资。
 * 并列出主要设备清单（规格×数量×单价×合价）。
 * 依赖：DEVICE_DB（取组件/逆变器/电池/变压器规格价）。DOM-free，可在 vm 测试。
 */

const BOM = {
  /**
   * @param {object} cfg 配置（含 selected/pv/storage/charger/diesel/load）
   * @param {object} result Engine.run 结果（含 capexBreakdown）
   * @param {object} [opts] { installRate=0.15, otherRate=0.08, contingencyRate=0.03, idc=0 }
   */
  estimate(cfg, result, opts) {
    opts = opts || {};
    const eb = (result && result.capexBreakdown) || {};
    const equipment = (eb.pv || 0) + (eb.storage || 0) + (eb.charger || 0) + (eb.diesel || 0);
    const installRate = opts.installRate != null ? opts.installRate : 0.15;       // 建安费率
    const otherRate = opts.otherRate != null ? opts.otherRate : 0.08;             // 其他费用率
    const contingencyRate = opts.contingencyRate != null ? opts.contingencyRate : 0.03;
    const install = equipment * installRate;
    const other = (equipment + install) * otherRate;
    const contingency = (equipment + install + other) * contingencyRate;
    const idc = opts.idc || 0;                                                    // 建设期利息(可研由 finance2 提供)
    const total = equipment + install + other + contingency + idc;
    return {
      equipment, install, other, contingency, idc, total,
      rows: [
        { name: '一、设备购置费', amount: equipment },
        { name: '二、建筑安装工程费', amount: install, note: `按设备 ${(installRate * 100).toFixed(0)}%` },
        { name: '三、其他费用（设计/监理/接入/项目管理）', amount: other, note: `按 ${(otherRate * 100).toFixed(0)}%` },
        { name: '四、基本预备费', amount: contingency, note: `按 ${(contingencyRate * 100).toFixed(0)}%` },
        { name: '五、建设期利息', amount: idc },
        { name: '动态总投资', amount: total, bold: true }
      ]
    };
  },

  /** 主要设备清单 BOM */
  deviceList(cfg) {
    const items = [];
    const db = (typeof DEVICE_DB !== 'undefined') ? DEVICE_DB : null;
    const sel = cfg.selected || {};
    const push = (name, spec, qty, unit, unitPrice) =>
      items.push({ name, spec, qty: Math.round(qty), unit, unitPrice: Math.round(unitPrice), amount: Math.round(qty * unitPrice) });

    if (sel.pv && cfg.pv) {
      const kw = cfg.pv.capacityKw || 0;
      const mod = db ? db.pvModules.find(m => m.id === cfg.pv.moduleId) || db.pvModules[1] : { pmax: 590, pricePerW: 0.9, name: 'N型组件' };
      const nMod = Math.ceil(kw * 1000 / mod.pmax);
      push('光伏组件', mod.name, nMod, '块', mod.pmax * mod.pricePerW);
      const inv = db ? db.inverters[1] : { kw: 500, pricePerW: 0.13, name: '逆变器' };
      const nInv = Math.max(1, Math.ceil(kw / (inv.kw * (cfg.pv.dcac || 1.15))));
      push('逆变器', inv.name, nInv, '台', inv.kw * 1000 * inv.pricePerW);
      push('支架/电缆/汇流/施工辅材', '配套', 1, '项', kw * 1000 * 0.6);
    }
    if (sel.storage && cfg.storage) {
      const kwh = cfg.storage.capacityKwh || 0, kw = cfg.storage.powerKw || 0;
      push('储能电池系统', (db ? db.batteries[1].name : 'LFP') + ` ${Math.round(kwh)}kWh`, 1, '套', kwh * 1000 * (cfg.storage.capexPerWh || 0.95) * 0.6);
      push('储能变流器 PCS', `${Math.round(kw)}kW`, 1, '套', kw * 1000 * 0.3);
      push('EMS/温控/消防/集装箱', '配套', 1, '项', kwh * 1000 * (cfg.storage.capexPerWh || 0.95) * 0.1);
    }
    if (sel.charger && cfg.charger) {
      push('充电桩', `直流 ${cfg.charger.powerKw}kW`, cfg.charger.count, '台', cfg.charger.capexPerUnit);
    }
    if (sel.diesel && cfg.diesel) {
      push('柴油发电机组', `${Math.round(cfg.diesel.capacityKw)}kW`, 1, '台', cfg.diesel.capacityKw * 1000 * (cfg.diesel.capexPerW || 1.5));
    }
    // 变压器（按受电容量选标准容量）
    const kva = (cfg.load && cfg.load.transformerKVA) || 0;
    if (kva > 0 && db) {
      const std = db.pickTransformer(kva);
      push('升压/配电变压器', `${std} kVA`, 1, '台', std * 120);   // 估算 120 元/kVA
    }
    return items;
  }
};

if (typeof module !== 'undefined') module.exports = { BOM };
