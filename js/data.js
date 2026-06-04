/**
 * data.js — 基础数据层
 * 地区参数（电价/光照/补贴）、设备默认参数、全局常量。
 * 所有数据均可在界面中覆盖，这里提供符合市场的缺省值。
 */

/* ------------------------------------------------------------------ *
 * 地区库：电价机制 + 光照资源 + 政策
 * 电价单位：元/kWh；需量电价：元/kW/月；光照：等效满发小时(峰值日照) kWh/kW/年
 * TOU 时段以 24 小时数组表示，每个元素是该小时所属价格段：
 *   'sharp' 尖峰 / 'peak' 高峰 / 'flat' 平段 / 'valley' 低谷
 * ------------------------------------------------------------------ */
const REGIONS = {
  cn_ci_east: {
    name: '中国·华东工商业（江浙沪）',
    currency: '¥',
    type: 'commercial',
    // 分时电价（典型两部制工商业，1-10kV）
    tou: {
      sharp: 1.35, peak: 1.15, flat: 0.70, valley: 0.35,
      // 24 小时归属（0 点 → 23 点）
      schedule: [
        'valley','valley','valley','valley','valley','valley', // 0-5
        'flat','flat',                                          // 6-7
        'peak','peak','peak',                                   // 8-10
        'sharp','sharp',                                        // 11-12
        'flat','flat','flat',                                   // 13-15
        'peak','peak','peak',                                   // 16-18
        'sharp','sharp',                                        // 19-20
        'peak',                                                 // 21
        'flat','valley'                                         // 22-23
      ]
    },
    demandCharge: 42,        // 元/kW/月（按最大需量）
    pvYield: 1150,           // kWh/kW/年（华东典型）
    feedInPrice: 0.42,       // 余电上网电价 元/kWh
    subsidy: 0.0,            // 度电补贴 元/kWh（地方，缺省 0）
    carbonFactor: 0.58       // 电网排放因子 tCO2/MWh
  },

  cn_ci_north: {
    name: '中国·华北工商业（京津冀）',
    currency: '¥',
    type: 'commercial',
    tou: {
      sharp: 1.28, peak: 1.08, flat: 0.66, valley: 0.33,
      schedule: [
        'valley','valley','valley','valley','valley','valley',
        'flat','flat',
        'peak','peak','peak','peak',
        'flat','flat','flat','flat',
        'peak','peak','peak',
        'sharp','sharp',
        'peak','flat','valley'
      ]
    },
    demandCharge: 40,
    pvYield: 1300,
    feedInPrice: 0.40,
    subsidy: 0.0,
    carbonFactor: 0.62
  },

  cn_ci_south: {
    name: '中国·南方工商业（广东）',
    currency: '¥',
    type: 'commercial',
    tou: {
      sharp: 1.40, peak: 1.18, flat: 0.72, valley: 0.34,
      schedule: [
        'valley','valley','valley','valley','valley','valley','valley','valley', // 0-7 谷段长（南方夜间谷电充裕）
        'flat','flat',                                          // 8-9
        'peak','peak','peak',                                   // 10-12
        'flat','flat','flat',                                   // 13-15
        'peak','peak',                                          // 16-17
        'sharp','sharp',                                        // 18-19
        'peak','peak',                                          // 20-21
        'flat','valley'                                         // 22-23
      ]
    },
    demandCharge: 45,
    pvYield: 1100,
    feedInPrice: 0.45,
    subsidy: 0.0,
    carbonFactor: 0.51
  },

  cn_residential: {
    name: '中国·户用（居民阶梯/分时）',
    currency: '¥',
    type: 'residential',
    tou: {
      sharp: 0.85, peak: 0.85, flat: 0.56, valley: 0.30,
      schedule: [
        'valley','valley','valley','valley','valley','valley','valley','valley',
        'flat','flat','flat','flat','flat','flat',
        'peak','peak','peak','peak','peak','peak',
        'flat','flat','valley','valley'
      ]
    },
    demandCharge: 0,         // 户用一般无需量电费
    pvYield: 1150,
    feedInPrice: 0.42,
    subsidy: 0.0,
    carbonFactor: 0.58
  },

  overseas_eu: {
    name: '海外·欧洲（高电价示例）',
    currency: '€',
    type: 'commercial',
    tou: {
      sharp: 0.45, peak: 0.38, flat: 0.28, valley: 0.15,
      schedule: [
        'valley','valley','valley','valley','valley','valley',
        'flat','flat',
        'peak','peak','peak','peak',
        'flat','flat','flat','flat','flat',
        'peak','peak','peak','peak',
        'flat','valley','valley'
      ]
    },
    demandCharge: 8,         // €/kW/月
    pvYield: 1050,
    feedInPrice: 0.10,
    subsidy: 0.0,
    carbonFactor: 0.30
  }
};

/* ------------------------------------------------------------------ *
 * 设备默认参数（造价、效率、寿命等，符合 2025 年市场行情）
 * ------------------------------------------------------------------ */
const DEVICE_DEFAULTS = {
  pv: {
    capacityKw: 500,          // 装机容量 kW
    capexPerKw: 3.2,          // 元/W → 这里用 元/W * 1000 不便，直接用 元/kW = 3200? 统一用"元/W"输入更直观
    capexPerW: 3.2,           // 元/W（含组件/逆变器/支架/施工）
    degradationY1: 0.02,      // 首年衰减
    degradation: 0.005,       // 逐年衰减
    selfUseRatio: 0.85,       // 自发自用比例（其余上网）
    omPerKwYear: 50,          // 运维 元/kW/年
    lifeYears: 25,
    areaPerKw: 5.5            // 占地/屋顶面积 m²/kW（估算用）
  },
  storage: {
    capacityKwh: 1000,        // 容量 kWh
    powerKw: 500,             // 功率 kW（PCS）
    capexPerKwh: 1.0,         // 元/Wh → 元/kWh = 1000? 用 元/Wh 直观：1.0 元/Wh = 1000 元/kWh
    capexPerWh: 1.0,          // 元/Wh（含电芯/PCS/EMS/施工，2025 工商业储能均价 0.9-1.1）
    efficiency: 0.90,         // 充放电循环综合效率
    dod: 0.95,                // 放电深度
    cyclesPerDay: 1.5,        // 每日循环次数（两充两放可达 2）
    degradation: 0.025,       // 容量逐年衰减
    omPerKwhYear: 20,         // 运维 元/kWh/年
    lifeYears: 10,            // 电池寿命（到期需更换或残值）
    minSoc: 0.05
  },
  charger: {
    count: 4,                 // 充电桩数量
    powerKw: 120,             // 单桩功率 kW（直流快充）
    capexPerUnit: 60000,      // 单桩造价 元（含设备+建设）
    utilizationHours: 4,      // 日均有效充电小时
    serviceFee: 0.6,          // 服务费 元/kWh（核心收入）
    occupyValley: 0.3,        // 充电电量中处于谷段的比例（影响购电成本）
    omPerUnitYear: 3000,      // 运维 元/桩/年
    lifeYears: 10
  },
  diesel: {
    capacityKw: 300,          // 额定功率 kW
    capexPerKw: 1.5,          // 元/W → 元/kW；用 元/W 直观：1.5 元/W
    capexPerW: 1.5,
    fuelPerKwh: 0.28,         // 柴油消耗 L/kWh（典型 0.25-0.3）
    fuelPrice: 7.8,           // 柴油价格 元/L
    runHoursYear: 200,        // 年运行小时（备用/调峰）
    loadFactor: 0.7,          // 平均负载率
    omPerKwhYear: 0.1,        // 运维 元/kWh
    carbonPerL: 2.68,         // 柴油排放 kgCO2/L
    lifeYears: 15
  }
};

/* ------------------------------------------------------------------ *
 * 负荷类型曲线模板（24 小时归一化，简化版用；专业版会插值到 8760）
 * 数值是相对系数，引擎会按"年用电量/峰值负荷"缩放。
 * ------------------------------------------------------------------ */
const LOAD_PROFILES = {
  single_shift: { // 单班制工厂（白天用电为主）
    name: '单班制（白天为主）',
    shape: [0.3,0.3,0.3,0.3,0.3,0.35,0.5,0.7,0.95,1.0,1.0,0.95,0.7,0.9,1.0,1.0,0.9,0.7,0.5,0.4,0.35,0.3,0.3,0.3]
  },
  double_shift: { // 两班制
    name: '两班制（早晚高峰）',
    shape: [0.4,0.4,0.4,0.4,0.45,0.5,0.7,0.85,0.95,1.0,1.0,0.95,0.85,0.95,1.0,1.0,0.95,0.85,0.8,0.75,0.7,0.6,0.5,0.45]
  },
  three_shift: { // 三班制（连续生产，较平）
    name: '三班制（连续生产）',
    shape: [0.8,0.8,0.78,0.78,0.78,0.8,0.85,0.9,0.95,1.0,1.0,0.95,0.9,0.95,1.0,1.0,0.95,0.9,0.9,0.88,0.85,0.85,0.82,0.8]
  },
  commercial: { // 商业楼宇
    name: '商业楼宇（营业时段）',
    shape: [0.2,0.2,0.2,0.2,0.2,0.25,0.35,0.5,0.7,0.9,1.0,1.0,0.95,0.95,1.0,1.0,0.95,0.9,0.85,0.7,0.5,0.35,0.25,0.2]
  },
  residential: { // 居民
    name: '居民（早晚高峰）',
    shape: [0.4,0.35,0.3,0.3,0.3,0.35,0.5,0.7,0.6,0.5,0.45,0.5,0.55,0.45,0.4,0.45,0.6,0.8,1.0,1.0,0.95,0.85,0.7,0.5]
  }
};

/* ------------------------------------------------------------------ *
 * 标准光伏出力曲线（晴天归一化 24h，引擎按地区年发电量缩放）
 * 仅白天有出力，正午峰值=1。专业版叠加季节/天气波动。
 * ------------------------------------------------------------------ */
const PV_PROFILE_BASE = [
  0,0,0,0,0,0.02,0.10,0.25,0.45,0.65,0.82,0.95,
  1.0,0.95,0.85,0.70,0.50,0.30,0.12,0.03,0,0,0,0
];

// 月度辐照修正系数（北半球，1-12 月），专业版用于季节波动
const MONTHLY_IRRADIANCE = [0.62,0.72,0.92,1.05,1.18,1.20,1.22,1.15,1.00,0.85,0.65,0.55];

if (typeof module !== 'undefined') {
  module.exports = { REGIONS, DEVICE_DEFAULTS, LOAD_PROFILES, PV_PROFILE_BASE, MONTHLY_IRRADIANCE };
}
