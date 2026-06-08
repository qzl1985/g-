/**
 * devicedb.js — 设备型号库（可研/概算用主流型号与参数）
 * 提供光伏组件、逆变器、储能电池、变压器标准序列等可选型号与缺省参数。
 * 数据均为 2025 年市场近似值，界面可改。零依赖、DOM-free。
 */

const DEVICE_DB = {
  // 光伏组件（额定功率/效率/温度系数/NOCT/衰减/单价）
  pvModules: [
    { id: 'mono_550', name: '单晶 PERC 550W', pmax: 550, eff: 0.213, tempCoef: -0.0035, noct: 45, degradeY1: 0.02, degrade: 0.0055, pricePerW: 0.85 },
    { id: 'ntype_590', name: 'N型 TOPCon 590W', pmax: 590, eff: 0.226, tempCoef: -0.0030, noct: 44, degradeY1: 0.01, degrade: 0.0040, pricePerW: 0.92 },
    { id: 'ntype_625', name: 'N型 HJT 625W', pmax: 625, eff: 0.233, tempCoef: -0.0024, noct: 43, degradeY1: 0.01, degrade: 0.0035, pricePerW: 1.05 }
  ],
  // 逆变器（额定/最高效率/单价 元/W·AC）
  inverters: [
    { id: 'str_100', name: '组串逆变器 100kW', kw: 100, effMax: 0.986, pricePerW: 0.18 },
    { id: 'cen_500', name: '集中逆变器 500kW', kw: 500, effMax: 0.989, pricePerW: 0.13 }
  ],
  // 储能电池（LFP，循环/日历寿命/单价 元/Wh）
  batteries: [
    { id: 'lfp_280', name: '磷酸铁锂 280Ah', cycleLife: 6000, calendarLife: 12, eolSoh: 0.8, etaRt: 0.90, pricePerWh: 0.9 },
    { id: 'lfp_314', name: '磷酸铁锂 314Ah', cycleLife: 8000, calendarLife: 15, eolSoh: 0.8, etaRt: 0.92, pricePerWh: 0.95 }
  ],
  // 变压器标准容量序列（kVA）
  transformerKVA: [200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150],

  // 取标准变压器容量（向上取整到标准序列）
  pickTransformer(kva) {
    for (const s of this.transformerKVA) if (s >= kva) return s;
    return this.transformerKVA[this.transformerKVA.length - 1];
  },
  pvModule(id) { return this.pvModules.find(m => m.id === id) || this.pvModules[1]; },
  inverter(id) { return this.inverters.find(m => m.id === id) || this.inverters[1]; },
  battery(id) { return this.batteries.find(m => m.id === id) || this.batteries[0]; }
};

if (typeof module !== 'undefined') module.exports = { DEVICE_DB };
