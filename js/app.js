/**
 * app.js — 界面交互与编排
 * 连接数据/引擎/优化/预测/助手，处理表单、渲染结果、绘制图表。
 */

const App = {
  state: {
    selected: { pv: true, storage: true, charger: false, diesel: false },
    params: JSON.parse(JSON.stringify(DEVICE_DEFAULTS)),
    load: {
      monthly: new Array(12).fill(250000),     // 各月用电量 kWh（默认年 300 万均摊）
      dataTier: 'template',
      hourly: LOAD_PROFILES.three_shift.shape.slice()  // 逐时负荷表默认值
    },
    storageMode: 'auto',                        // 储能容量：auto 自动反算 / manual 手动
    bills: [],                                  // 已识别的电费单（计费真值）
    lastResult: null
  },

  MONTH_NAMES: ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'],

  // 设备元信息（图标 / 名称 / 说明）
  DEVICES: {
    pv:      { icon: '☀️', name: '光伏', desc: '屋顶/地面发电，自发自用' },
    storage: { icon: '🔋', name: '储能', desc: '峰谷套利 / 削峰填谷' },
    charger: { icon: '🔌', name: '充电桩', desc: '服务费收入型资产' },
    diesel:  { icon: '⛽', name: '柴油发电机', desc: '备用 / 调峰' }
  },

  // 各设备可编辑参数表（key 对应 DEVICE_DEFAULTS）
  PARAM_SCHEMA: {
    pv: [
      ['capacityKw', '装机容量', 'kW'],
      ['capexPerW', '单位造价', '元/W'],
      ['selfUseRatio', '自用比例', '0~1'],
      ['degradation', '逐年衰减', '0~1'],
      ['omPerKwYear', '运维', '元/kW/年'],
      ['areaPerKw', '占地', 'm²/kW']
    ],
    storage: [
      ['capacityKwh', '容量', 'kWh'],
      ['powerKw', '功率(PCS)', 'kW'],
      ['capexPerWh', '单位造价', '元/Wh'],
      ['efficiency', '综合效率', '0~1'],
      ['cyclesPerDay', '日循环次数', '次'],
      ['dod', '放电深度', '0~1'],
      ['degradation', '逐年衰减', '0~1'],
      ['lifeYears', '电池寿命', '年']
    ],
    charger: [
      ['count', '数量', '台'],
      ['powerKw', '单桩功率', 'kW'],
      ['capexPerUnit', '单桩造价', '元'],
      ['utilizationHours', '日均充电', '小时'],
      ['serviceFee', '服务费', '元/kWh'],
      ['occupyValley', '谷段充电占比', '0~1']
    ],
    diesel: [
      ['capacityKw', '额定功率', 'kW'],
      ['capexPerW', '单位造价', '元/W'],
      ['fuelPerKwh', '油耗', 'L/kWh'],
      ['fuelPrice', '油价', '元/L'],
      ['runHoursYear', '年运行', '小时'],
      ['loadFactor', '负载率', '0~1']
    ]
  },

  // ============ 初始化 ============
  init() {
    // 每一步独立容错：任一步出错都不致整页空白
    const safe = (label, fn) => { try { fn(); } catch (e) { console.error('[init] ' + label, e); } };
    safe('fillRegions', () => this.fillRegions());
    safe('fillLoadProfiles', () => this.fillLoadProfiles());
    safe('renderMonths', () => this.renderMonths());
    safe('renderHourly', () => this.renderHourly());
    safe('renderDeviceToggles', () => this.renderDeviceToggles());
    safe('renderParamForms', () => this.renderParamForms());
    safe('updateLoadTierUI', () => this.updateLoadTierUI());
    safe('updateStorageSizingUI', () => this.updateStorageSizingUI());
    safe('fillPvModules', () => this.fillPvModules());
    safe('bindEvents', () => this.bindEvents());
    safe('loadLlmConfig', () => this.loadLlmConfig());
    safe('renderCompare', () => this.renderCompare());
  },

  fillPvModules() {
    const sel = document.getElementById('pvModuleSel');
    if (!sel || typeof DEVICE_DB === 'undefined') return;
    sel.innerHTML = DEVICE_DB.pvModules.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
    sel.value = 'ntype_590';
  },

  engineeringOn() {
    const el = document.getElementById('engEnable');
    return !!(el && el.checked);
  },

  // 渲染 12 个月用电量输入
  renderMonths() {
    const box = document.getElementById('monthsGrid');
    box.innerHTML = this.state.load.monthly.map((v, i) => `
      <div class="mcell">
        <span>${this.MONTH_NAMES[i]}</span>
        <input type="number" data-mon="${i}" value="${v}" />
      </div>`).join('');
  },

  // 渲染 24 小时逐时负荷输入
  renderHourly() {
    const box = document.getElementById('hourlyGrid');
    box.innerHTML = this.state.load.hourly.map((v, i) => `
      <div class="mcell">
        <span>${i}时</span>
        <input type="number" step="0.05" data-hr="${i}" value="${(+v).toFixed(2)}" />
      </div>`).join('');
  },

  // 根据负荷数据精度显示/隐藏对应输入区
  updateLoadTierUI() {
    const tier = document.getElementById('dataTier').value;
    document.getElementById('profileField').classList.toggle('hidden', tier === 'hourly');
    document.getElementById('touFields').classList.toggle('hidden', tier !== 'tou');
    document.getElementById('hourlyFields').classList.toggle('hidden', tier !== 'hourly');
  },

  // 储能被选中时才显示"储能容量确定"卡片，并按模式启停反算
  updateStorageSizingUI() {
    document.getElementById('storageSizingCard').classList.toggle('hidden', !this.state.selected.storage);
  },

  fillRegions() {
    const sel = document.getElementById('regionSelect');
    sel.innerHTML = Object.entries(REGIONS)
      .map(([k, r]) => `<option value="${k}">${r.name}</option>`).join('');
    sel.value = 'cn_ci_east';
  },

  fillLoadProfiles() {
    const opts = Object.entries(LOAD_PROFILES)
      .map(([k, p]) => `<option value="${k}">${p.name}</option>`).join('');
    document.getElementById('loadProfile').innerHTML = opts;
    document.getElementById('loadProfile').value = 'three_shift';
  },

  renderDeviceToggles() {
    const box = document.getElementById('deviceToggles');
    box.innerHTML = Object.entries(this.DEVICES).map(([k, d]) => `
      <label class="dev-toggle ${this.state.selected[k] ? 'on' : ''}" data-dev="${k}">
        <span class="ico">${d.icon}</span>
        <span>
          <div class="name">${d.name}</div>
          <div class="desc">${d.desc}</div>
        </span>
        <input type="checkbox" ${this.state.selected[k] ? 'checked' : ''} />
      </label>
    `).join('');
  },

  renderParamForms() {
    const box = document.getElementById('paramForms');
    box.innerHTML = Object.keys(this.DEVICES).map(dev => {
      if (!this.state.selected[dev]) return '';
      const d = this.DEVICES[dev];
      const fields = this.PARAM_SCHEMA[dev].map(([key, label, unit]) => `
        <div class="field">
          <label>${label} <small>${unit}</small></label>
          <input type="number" step="any" data-dev="${dev}" data-key="${key}"
                 value="${this.state.params[dev][key]}" />
        </div>`).join('');
      return `<details class="param-group" open>
        <summary>${d.icon} ${d.name}</summary>
        <div class="param-body">${fields}</div>
      </details>`;
    }).join('') || '<p class="hint">请先在上方勾选至少一种设备。</p>';
  },

  // ============ 事件绑定 ============
  bindEvents() {
    // Tab 切换
    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      document.getElementById('tab-' + t.dataset.tab).classList.add('active');
    }));

    // 设备勾选
    document.getElementById('deviceToggles').addEventListener('click', (e) => {
      const lbl = e.target.closest('.dev-toggle');
      if (!lbl) return;
      const dev = lbl.dataset.dev;
      // 让原生 checkbox 状态稳定
      setTimeout(() => {
        this.state.selected[dev] = lbl.querySelector('input').checked;
        lbl.classList.toggle('on', this.state.selected[dev]);
        this.renderParamForms();
        this.updateStorageSizingUI();
      }, 0);
    });

    // 月度用电量输入
    document.getElementById('monthsGrid').addEventListener('input', (e) => {
      const i = e.target.dataset.mon;
      if (i !== undefined) this.state.load.monthly[+i] = parseFloat(e.target.value) || 0;
    });
    // 逐时负荷输入
    document.getElementById('hourlyGrid').addEventListener('input', (e) => {
      const i = e.target.dataset.hr;
      if (i !== undefined) this.state.load.hourly[+i] = parseFloat(e.target.value) || 0;
    });
    // 负荷数据精度切换
    document.getElementById('dataTier').addEventListener('change', () => {
      this.state.load.dataTier = document.getElementById('dataTier').value;
      this.updateLoadTierUI();
    });
    // 年总量均摊到 12 月
    document.getElementById('fillEven').addEventListener('click', () => {
      const annual = parseFloat(document.getElementById('annualFill').value) || 0;
      if (annual <= 0) { alert('请先在左侧输入年总用电量'); return; }
      const per = Math.round(annual / 12);
      this.state.load.monthly = new Array(12).fill(per);
      this.renderMonths();
    });
    // 逐时负荷用典型曲线填充
    document.getElementById('hourlyFromTpl').addEventListener('click', () => {
      const prof = document.getElementById('loadProfile').value;
      this.state.load.hourly = (LOAD_PROFILES[prof] || LOAD_PROFILES.three_shift).shape.slice();
      this.renderHourly();
    });
    // 储能容量确定方式
    document.getElementById('storageMode').addEventListener('change', () => {
      this.state.storageMode = document.getElementById('storageMode').value;
    });
    // 立即反算储能容量
    document.getElementById('sizeStorageBtn').addEventListener('click', () => this.doSizeStorage(true));

    // 可研级评价开关
    document.getElementById('engEnable').addEventListener('change', () => {
      document.getElementById('engParams').classList.toggle('hidden', !this.engineeringOn());
    });

    // 电费单校准
    document.getElementById('billFile').addEventListener('change', (e) => this.onBillFile(e));
    document.getElementById('billParseBtn').addEventListener('click', () => this.parseBillPaste());
    document.getElementById('billAddBtn').addEventListener('click', () => this.addBillFromForm());
    document.getElementById('billApplyBtn').addEventListener('click', () => this.applyBillCalibration());
    document.getElementById('billClearBtn').addEventListener('click', () => { this.state.bills = []; this.renderBillList(); document.getElementById('billNote').classList.add('hidden'); });
    document.getElementById('billSample').addEventListener('click', () => this.showBillSample());
    document.getElementById('billTemplate').addEventListener('click', () => this.downloadBillTemplate());
    document.getElementById('loadTemplate').addEventListener('click', () => this.downloadLoadTemplate());

    // 南网一键
    document.getElementById('nwRunBtn').addEventListener('click', () => this.runNanwang());

    // 负荷表导入
    document.getElementById('loadFile').addEventListener('change', (e) => this.onLoadFile(e));
    document.getElementById('loadPaste').addEventListener('input', () => { this._importedRows = null; this._importedNames = null; });
    document.getElementById('parseLoadBtn').addEventListener('click', () => this.parseLoadTable());
    document.getElementById('applyLoadBtn').addEventListener('click', () => this.applyLoadTable());
    document.getElementById('loadSample').addEventListener('click', () => this.showLoadSample());

    // 参数输入
    document.getElementById('paramForms').addEventListener('input', (e) => {
      const i = e.target;
      if (i.dataset.dev && i.dataset.key) {
        this.state.params[i.dataset.dev][i.dataset.key] = parseFloat(i.value) || 0;
      }
    });

    document.getElementById('runBtn').addEventListener('click', () => this.run());
    document.getElementById('resetBtn').addEventListener('click', () => this.reset());
    document.getElementById('optRunBtn').addEventListener('click', () => this.runOptimize());
    document.getElementById('dispatchBtn').addEventListener('click', () => this.runDispatch());
    document.getElementById('applyOptBtn').addEventListener('click', () => this.applyOpt());

    // 助手
    document.getElementById('chatSend').addEventListener('click', () => this.sendChat());
    document.getElementById('chatInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this.sendChat();
    });
    document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
      document.getElementById('chatInput').value = c.dataset.ex;
      this.sendChat();
    }));

    // 大模型设置
    document.getElementById('llmSave').addEventListener('click', () => this.saveLlmConfig());

    // 方案保存
    document.getElementById('saveScenarioBtn').addEventListener('click', () => this.saveScenario());

    // 报告导出
    document.getElementById('exportCsvBtn').addEventListener('click', () => this.exportCSV());
    document.getElementById('exportPdfBtn').addEventListener('click', () => this.exportPDF());

    // 方案对比表内的操作（载入/删除）
    document.getElementById('compareTable').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'del') this.deleteScenario(btn.dataset.id);
      if (btn.dataset.act === 'load') this.loadScenario(btn.dataset.id);
    });
  },

  // ============ 大模型配置 ============
  loadLlmConfig() {
    let c = null;
    try { c = JSON.parse(localStorage.getItem('nev_llm') || 'null'); } catch (e) {}
    if (c) {
      document.getElementById('llmBase').value = c.baseUrl || '';
      document.getElementById('llmModel').value = c.model || '';
      document.getElementById('llmKey').value = c.apiKey || '';
      document.getElementById('llmSettings').open = true;
    }
  },
  saveLlmConfig() {
    const c = {
      baseUrl: document.getElementById('llmBase').value.trim(),
      model: document.getElementById('llmModel').value.trim(),
      apiKey: document.getElementById('llmKey').value.trim()
    };
    if (!c.baseUrl || !c.apiKey) { localStorage.removeItem('nev_llm'); alert('已清除大模型设置，将使用内置规则引擎。'); return; }
    localStorage.setItem('nev_llm', JSON.stringify(c));
    alert('大模型设置已保存（仅存于本地浏览器）。');
  },

  // ============ 方案保存 / 对比 ============
  scenarios() {
    try { return JSON.parse(localStorage.getItem('nev_scenarios') || '[]'); } catch (e) { return []; }
  },
  saveScenario() {
    const r = this.state.lastResult, cfg = this.state.lastCfg;
    if (!r) { alert('请先测算'); return; }
    const name = prompt('为该方案命名：', '方案 ' + (this.scenarios().length + 1));
    if (name === null) return;
    const devices = Object.entries(cfg.selected).filter(([, v]) => v)
      .map(([k]) => this.DEVICES[k].name).join('+');
    const f = r.finance;
    const list = this.scenarios();
    list.push({
      id: String(Date.now()),
      name: name || ('方案 ' + (list.length + 1)),
      regionName: r.region.name,
      currency: r.region.currency,
      devices,
      capex: r.capex, npv: f.npv, irr: f.irr,
      payback: f.paybackStatic, lcoe: f.lcoe, avgAnnual: f.avgAnnual,
      carbon: r.env.carbonCut,
      cfg
    });
    localStorage.setItem('nev_scenarios', JSON.stringify(list));
    this.renderCompare();
    alert('已保存。可在"📁 方案对比"页查看。');
  },
  deleteScenario(id) {
    const list = this.scenarios().filter(s => s.id !== id);
    localStorage.setItem('nev_scenarios', JSON.stringify(list));
    this.renderCompare();
  },
  loadScenario(id) {
    const s = this.scenarios().find(x => x.id === id);
    if (!s || !s.cfg) return;
    const c = s.cfg;
    const g = id => document.getElementById(id);
    g('regionSelect').value = c.regionKey;
    g('modeSelect').value = c.mode || 'simplified';
    const L = c.load || {};
    if (L.monthly && L.monthly.length === 12) { this.state.load.monthly = L.monthly.slice(); this.renderMonths(); }
    this.state.load.dataTier = L.dataTier || 'template';
    g('dataTier').value = this.state.load.dataTier;
    g('loadProfile').value = L.profile || 'three_shift';
    if (L.tou) {
      g('touSharp').value = Math.round((L.tou.sharp || 0) * 100);
      g('touPeak').value = Math.round((L.tou.peak || 0) * 100);
      g('touFlat').value = Math.round((L.tou.flat || 0) * 100);
      g('touValley').value = Math.round((L.tou.valley || 0) * 100);
    }
    if (L.hourly && L.hourly.length === 24) { this.state.load.hourly = L.hourly.slice(); this.renderHourly(); }
    g('transformerKVA').value = L.transformerKVA || 0;
    g('peakKw').value = L.peakKw || '';
    g('basicFeeMode').value = L.basicFeeMode || 'auto';
    g('discountRate').value = (c.discountRate * 100);
    g('projectYears').value = c.projectYears;
    this.state.selected = { ...c.selected };
    ['pv', 'storage', 'charger', 'diesel'].forEach(d => { if (c[d]) this.state.params[d] = { ...c[d] }; });
    this.state.storageMode = 'manual';   // 载入已保存容量，按手动处理避免被反算覆盖
    g('storageMode').value = 'manual';
    this.renderDeviceToggles();
    this.renderParamForms();
    this.updateLoadTierUI();
    this.updateStorageSizingUI();
    document.querySelector('.tab[data-tab="calc"]').click();
    this.run();
  },
  renderCompare() {
    const list = this.scenarios();
    const empty = document.getElementById('compareEmpty');
    const table = document.getElementById('compareTable');
    if (!list.length) { empty.classList.remove('hidden'); table.innerHTML = ''; return; }
    empty.classList.add('hidden');
    const cur = (s) => s.currency || '¥';
    const rows = [
      ['地区', s => s.regionName],
      ['设备组合', s => s.devices],
      ['总投资', s => this.money(s.capex, cur(s))],
      ['净现值 NPV', s => this.money(s.npv, cur(s))],
      ['内部收益率 IRR', s => s.irr !== null && s.irr !== undefined ? (s.irr * 100).toFixed(1) + '%' : '—'],
      ['静态回本期', s => (s.payback != null && isFinite(s.payback)) ? s.payback.toFixed(1) + ' 年' : '∞'],
      ['平准度电成本', s => s.lcoe && isFinite(s.lcoe) ? s.lcoe.toFixed(3) : '—'],
      ['年均净收益', s => this.money(s.avgAnnual, cur(s))],
      ['碳减排(tCO₂)', s => Math.round(s.carbon).toLocaleString()]
    ];
    let html = '<thead><tr><th>指标</th>' +
      list.map(s => `<th>${this._esc(s.name)} <button class="mini-x" data-act="del" data-id="${s.id}">✕</button></th>`).join('') +
      '</tr></thead><tbody>';
    rows.forEach(([label, fn]) => {
      html += `<tr><td>${label}</td>` + list.map(s => `<td>${fn(s)}</td>`).join('') + '</tr>';
    });
    html += `<tr><td>操作</td>` +
      list.map(s => `<td><button class="btn-ghost mini" data-act="load" data-id="${s.id}">载入测算</button></td>`).join('') +
      '</tr></tbody>';
    table.innerHTML = html;
  },
  _esc(s) { return String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); },

  // ============ 报告导出 ============
  /** 汇总设备配置明细，供 CSV / PDF 共用 */
  _deviceLines(cfg, r) {
    const lines = [];
    if (cfg.selected.pv) lines.push(['光伏', `装机 ${Math.round(cfg.pv.capacityKw)} kW · ${cfg.pv.capexPerW} 元/W`, r.capexBreakdown.pv]);
    if (cfg.selected.storage) lines.push(['储能', `${Math.round(cfg.storage.capacityKwh)} kWh / ${Math.round(cfg.storage.powerKw)} kW · ${cfg.storage.capexPerWh} 元/Wh`, r.capexBreakdown.storage]);
    if (cfg.selected.charger) lines.push(['充电桩', `${cfg.charger.count} 台 × ${cfg.charger.powerKw} kW`, r.capexBreakdown.charger]);
    if (cfg.selected.diesel) lines.push(['柴油发电机', `${Math.round(cfg.diesel.capacityKw)} kW · ${cfg.diesel.capexPerW} 元/W`, r.capexBreakdown.diesel]);
    return lines;
  },

  /** 关键指标键值对（带格式化） */
  _kpiPairs(r) {
    const f = r.finance, cur = r.region.currency;
    return [
      ['总投资', this.money(r.capex, cur)],
      ['净现值 NPV', this.money(f.npv, cur)],
      ['内部收益率 IRR', f.irr !== null ? (f.irr * 100).toFixed(1) + '%' : '—'],
      ['静态回本期', isFinite(f.paybackStatic) ? f.paybackStatic.toFixed(1) + ' 年' : '不可回本'],
      ['动态回本期', isFinite(f.paybackDynamic) ? f.paybackDynamic.toFixed(1) + ' 年' : '不可回本'],
      ['平准度电成本 LCOE', f.lcoe && isFinite(f.lcoe) ? f.lcoe.toFixed(3) + ' ' + cur + '/kWh' : '—'],
      ['年均净收益', this.money(f.avgAnnual, cur)],
      ['全周期净收益', this.money(f.totalNet, cur)],
      ['全周期碳减排', Math.round(r.env.carbonCut).toLocaleString() + ' tCO₂']
    ];
  },

  exportCSV() {
    const r = this.state.lastResult, cfg = this.state.lastCfg;
    if (!r) { alert('请先测算'); return; }
    const cur = r.region.currency, f = r.finance;
    const rows = [];
    rows.push(['新能源投资测算报告']);
    rows.push(['生成时间', new Date().toLocaleString('zh-CN')]);
    rows.push(['地区', r.region.name]);
    rows.push(['测算精度', r.mode === 'professional' ? '专业逐时版(8760h)' : '简化快速版']);
    rows.push(['测算年限', r.years + ' 年']);
    rows.push(['年用电量(kWh)', Math.round(cfg.load.annualKwh)]);
    rows.push(['峰值负荷(kW)', Math.round(cfg.load.peakKw)]);
    rows.push([]);
    rows.push(['【设备配置】', '规格', '投资(' + cur + ')']);
    this._deviceLines(cfg, r).forEach(l => rows.push([l[0], l[1], Math.round(l[2])]));
    rows.push([]);
    rows.push(['【关键指标】']);
    this._kpiPairs(r).forEach(p => rows.push([p[0], p[1]]));
    rows.push([]);
    rows.push(['【逐年现金流】']);
    rows.push(['年度', '当年现金流(' + cur + ')', '累计现金流(' + cur + ')']);
    f.cashflows.forEach((cf, t) => rows.push([
      t === 0 ? '初始投资' : '第' + t + '年', Math.round(cf), Math.round(f.cumulative[t])
    ]));

    const csv = rows.map(row => row.map(c => {
      const s = String(c == null ? '' : c);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\n');
    const BOM = String.fromCharCode(0xFEFF);   // 让 Excel 正确识别 UTF-8 中文
    this._download(BOM + csv, '新能源投资测算_' + this._stamp() + '.csv', 'text/csv;charset=utf-8');
  },

  exportPDF() {
    const r = this.state.lastResult, cfg = this.state.lastCfg;
    if (!r) { alert('请先测算'); return; }
    let cashImg = '', capexImg = '';
    try { cashImg = document.getElementById('cashflowChart').toDataURL('image/png'); } catch (e) {}
    try { capexImg = document.getElementById('capexChart').toDataURL('image/png'); } catch (e) {}
    const html = this._reportHTML(r, cfg, cashImg, capexImg);
    const w = window.open('', '_blank');
    if (!w) { alert('请允许弹出窗口以生成 PDF 报告。'); return; }
    w.document.open(); w.document.write(html); w.document.close();
    // 等待图片与字体加载后唤起打印
    const fire = () => { try { w.focus(); w.print(); } catch (e) {} };
    w.onload = fire;
    setTimeout(fire, 600);
  },

  _reportHTML(r, cfg, cashImg, capexImg) {
    const f = r.finance, cur = r.region.currency;
    const dev = this._deviceLines(cfg, r).map(l =>
      `<tr><td>${l[0]}</td><td>${l[1]}</td><td class="num">${this.money(l[2], cur)}</td></tr>`).join('');
    const kpi = this._kpiPairs(r).map(p =>
      `<div class="kbox"><div class="kl">${p[0]}</div><div class="kv">${p[1]}</div></div>`).join('');
    const cash = f.cashflows.map((cf, t) =>
      `<tr><td>${t === 0 ? '初始投资' : '第 ' + t + ' 年'}</td>
       <td class="num ${cf >= 0 ? 'pos' : 'neg'}">${this.money(cf, cur)}</td>
       <td class="num ${f.cumulative[t] >= 0 ? 'pos' : 'neg'}">${this.money(f.cumulative[t], cur)}</td></tr>`).join('');
    const mode = r.mode === 'professional' ? '专业逐时版 (8760h)' : '简化快速版';
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/>
<title>新能源投资测算报告</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "PingFang SC","Microsoft YaHei",sans-serif; color:#1a2233; margin:32px; }
  h1 { font-size:22px; margin:0 0 4px; }
  h2 { font-size:15px; margin:24px 0 10px; padding-bottom:6px; border-bottom:2px solid #2563eb; color:#1d4ed8; }
  .meta { color:#5b6478; font-size:12.5px; margin-bottom:6px; }
  .meta b { color:#1a2233; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th,td { padding:7px 10px; border-bottom:1px solid #e2e6ee; text-align:left; }
  th { background:#f3f6fc; color:#5b6478; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  td.pos { color:#0a8f3c; } td.neg { color:#d12f2f; }
  .kgrid { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }
  .kbox { border:1px solid #e2e6ee; border-radius:8px; padding:10px 12px; }
  .kbox .kl { font-size:11.5px; color:#5b6478; }
  .kbox .kv { font-size:17px; font-weight:700; margin-top:3px; }
  .charts { display:flex; gap:16px; flex-wrap:wrap; margin-top:8px; }
  .charts figure { flex:1; min-width:240px; margin:0; }
  .charts img { width:100%; border:1px solid #e2e6ee; border-radius:8px; background:#0f1729; }
  .charts figcaption { font-size:12px; color:#5b6478; margin-top:4px; text-align:center; }
  .disc { margin-top:24px; font-size:11px; color:#8a92a6; border-top:1px solid #e2e6ee; padding-top:10px; }
  @media print { body { margin:14mm; } h2 { page-break-after:avoid; } tr { page-break-inside:avoid; } }
</style></head><body>
  <h1>⚡ 新能源投资测算报告</h1>
  <div class="meta">生成时间：<b>${new Date().toLocaleString('zh-CN')}</b></div>
  <div class="meta">地区：<b>${r.region.name}</b> ｜ 测算精度：<b>${mode}</b> ｜ 测算年限：<b>${r.years} 年</b></div>
  <div class="meta">年用电量：<b>${Math.round(cfg.load.annualKwh).toLocaleString()} kWh</b> ｜ 峰值负荷：<b>${Math.round(cfg.load.peakKw).toLocaleString()} kW</b></div>

  <h2>一、设备配置</h2>
  <table><thead><tr><th>设备</th><th>规格</th><th class="num">投资</th></tr></thead>
  <tbody>${dev}<tr><td><b>合计</b></td><td></td><td class="num"><b>${this.money(r.capex, cur)}</b></td></tr></tbody></table>

  <h2>二、关键财务指标</h2>
  <div class="kgrid">${kpi}</div>

  <h2>三、图表</h2>
  <div class="charts">
    ${cashImg ? `<figure><img src="${cashImg}"/><figcaption>累计现金流</figcaption></figure>` : ''}
    ${capexImg ? `<figure><img src="${capexImg}"/><figcaption>投资构成</figcaption></figure>` : ''}
  </div>

  <h2>四、逐年现金流</h2>
  <table><thead><tr><th>年度</th><th class="num">当年现金流</th><th class="num">累计现金流</th></tr></thead>
  <tbody>${cash}</tbody></table>

  <div class="disc">本报告基于工程估算与公开市场参数自动生成，仅供投资决策初筛参考；
  实际收益受当地电价政策、设备选型、施工与运营等因素影响，请以最终工程方案为准。</div>
</body></html>`;
  },

  _stamp() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  },
  _download(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  // ============ 配置组装（供测算/优化/助手共用） ============
  buildConfig(overrides = {}) {
    const o = overrides;
    const cfg = {
      regionKey: o.regionKey || document.getElementById('regionSelect').value,
      mode: o.mode || document.getElementById('modeSelect').value,
      selected: o.selected || { ...this.state.selected },
      pv: { ...this.state.params.pv },
      storage: { ...this.state.params.storage },
      charger: { ...this.state.params.charger },
      diesel: { ...this.state.params.diesel },
      load: o.load || this.readLoad(),
      discountRate: (o.discountRate != null) ? o.discountRate : (parseFloat(document.getElementById('discountRate').value) / 100 || 0.06),
      projectYears: o.projectYears || parseInt(document.getElementById('projectYears').value) || 25,
      strategy: o.strategy || ['arbitrage', 'demand'],
      dispatchMode: o.dispatchMode || 'arbitrage'
    };
    // 自动补峰值（最大需量未填则按年用电量与负荷类型估算）
    const ann = cfg.load.monthly ? cfg.load.monthly.reduce((a, b) => a + (+b || 0), 0) : (cfg.load.annualKwh || 0);
    if (!cfg.load.peakKw && ann) {
      cfg.load.peakKw = Forecast.estimatePeakKw(ann, cfg.load.profile || 'double_shift');
    }
    // 应用 overrides 中的设备容量
    if (o.pv) Object.assign(cfg.pv, o.pv);
    if (o.storage) Object.assign(cfg.storage, o.storage);
    return cfg;
  },

  // 从界面读取完整负荷与电价配置
  readLoad() {
    const g = id => document.getElementById(id);
    return {
      monthly: this.state.load.monthly.slice(),
      dataTier: g('dataTier').value,
      profile: g('loadProfile').value,
      tou: {
        sharp: (parseFloat(g('touSharp').value) || 0) / 100,
        peak: (parseFloat(g('touPeak').value) || 0) / 100,
        flat: (parseFloat(g('touFlat').value) || 0) / 100,
        valley: (parseFloat(g('touValley').value) || 0) / 100
      },
      hourly: this.state.load.hourly.slice(),
      transformerKVA: parseFloat(g('transformerKVA').value) || 0,
      peakKw: parseFloat(g('peakKw').value) || 0,
      basicFeeMode: g('basicFeeMode').value
    };
  },

  // 储能容量反算（auto=true 时强制提示，run 内静默调用）
  doSizeStorage(announce) {
    if (!this.state.selected.storage) { if (announce) alert('请先勾选储能设备'); return null; }
    const cfg = this.buildConfig({ mode: 'simplified' });
    const sz = Optimizer.sizeStorage(cfg);
    if (sz.capacityKwh > 0) {
      this.state.params.storage.capacityKwh = sz.capacityKwh;
      this.state.params.storage.powerKw = sz.powerKw;
      this.renderParamForms();
    }
    const box = document.getElementById('sizeExplain');
    box.textContent = sz.explain;
    box.classList.remove('hidden');
    return sz;
  },

  // ============ 南网一键测算（负荷表 + 电费单 → 结合校准 → 出结果） ============
  async runNanwang() {
    const lf = (document.getElementById('nwLoadFile').files || [])[0];
    const bf = (document.getElementById('nwBillFile').files || [])[0];
    const note = document.getElementById('nwNote');
    if (!lf && !bf) { alert('请至少选择负荷表或电费单'); return; }
    note.classList.remove('hidden');
    note.textContent = '正在解析…';
    const msgs = [];
    try {
      // ① 负荷表（南网逐时 / 兆瓦时 / YYYYMMDD 已自动适配）
      if (lf) {
        const rows = await this.readFileToRows(lf);
        const res = LoadParser.parseRows(rows);
        if (res.ok) {
          this.state.load.monthly = res.monthly.map(v => Math.round(v));
          const mx = Math.max.apply(null, res.hourly) || 1;
          this.state.load.hourly = res.hourly.map(v => +(v / mx).toFixed(3));
          this.state.load.dataTier = 'hourly';
          this.state.load.measuredPeakKw = res.peakKw;
          this.state.load.measuredAnnual = res.annualKwh;
          document.getElementById('dataTier').value = 'hourly';
          document.getElementById('peakKw').value = res.peakKw;
          this.renderMonths(); this.renderHourly(); this.updateLoadTierUI();
          msgs.push('负荷表：' + res.note);
        } else { msgs.push('负荷表识别失败：' + res.error); }
      }
      // ② 电费单（南网规则 → 大模型/视觉兜底）
      if (bf) {
        let fields = null;
        if (/\.pdf$/i.test(bf.name)) {
          const ab = await bf.arrayBuffer();
          const r = await PdfReader.extractText(ab);
          if (r.text && r.text.replace(/\s/g, '').length > 10) fields = await this._extractBill(r.text);
          if (!this._hasBillData(fields)) {
            try { const img = await PdfReader.renderFirstPageImage(ab); const o = await Assistant.extractBillImage(img); if (this._hasBillData(o)) fields = o; } catch (e) {}
          }
        } else if (/^image\//.test(bf.type) || /\.(png|jpe?g|webp)$/i.test(bf.name)) {
          const u = await this._fileToDataUrl(bf);
          try { fields = await Assistant.extractBillImage(u); } catch (e) {}
        } else {
          const rows = await this.readFileToRows(bf);
          const list = BillParser.parseTable(rows);
          if (list.length) { list.forEach(b => this.state.bills.push(b)); }
          else fields = await this._extractBill(rows.map(r => r.join(' ')).join('\n'));
        }
        if (this._hasBillData(fields)) this.state.bills.push(BillParser.fromFields(fields));
        if (!this.state.bills.length) msgs.push('电费单未能自动识别（可在下方"🧾 电费单校准"用图片视觉或手工录入）。');
      }
      this.renderBillList();
      // ③ 结合校准并测算
      if (this.state.bills.length) {
        this.applyBillCalibration(true);   // 内部会 run()
        msgs.push('已结合电费单完成校准与测算，详见下方结果。');
      } else if (lf) {
        this.run();
        msgs.push('已按负荷表测算（无电费单，建议补电费单以校准分时电量与变压器容量）。');
      }
      note.textContent = '南网一键：\n· ' + msgs.join('\n· ');
    } catch (e) {
      note.textContent = '处理出错：' + (e.message || e);
    }
  },

  // ============ 电费单校准（PDF/图片/文本/录入 · 计费真值） ============
  async onBillFile(e) {
    const files = Array.from((e.target && e.target.files) || []);
    if (!files.length) return;
    const note = document.getElementById('billExtractNote');
    note.textContent = '正在识别 ' + files.length + ' 张电费单…';
    let added = 0;
    for (const f of files) {
      try {
        let fields = null;
        if (/\.pdf$/i.test(f.name)) {
          const ab = await f.arrayBuffer();
          const r = await PdfReader.extractText(ab);
          const readable = r.text && r.text.replace(/\s/g, '').length > 10;
          fields = readable ? await this._extractBill(r.text) : null;
          // 文字层识别失败 → 尝试 PDF 首页渲染成图片，走大模型视觉识别（扫描件可用）
          if (!this._hasBillData(fields)) {
            try {
              const img = await PdfReader.renderFirstPageImage(ab);
              const obj = await Assistant.extractBillImage(img);
              if (this._hasBillData(obj)) fields = obj;
            } catch (e) { /* pdf.js 未加载或无视觉模型 */ }
          }
          if (!this._hasBillData(fields)) {
            note.textContent = `「${f.name}」未能识别出电费单数据` +
              (r.via === 'pdfjs' ? '（PDF 文字层无有效字段）' : '（疑似扫描件/图片型 PDF）') +
              '。\n建议：①在「💬 AI 助手」配置【带视觉】的大模型后重试；②或把电费单【截图为图片】上传；③或在下方【结构化录入】手工填写。';
            continue;
          }
        } else if (/^image\//.test(f.type) || /\.(png|jpe?g|webp|bmp)$/i.test(f.name)) {
          const dataUrl = await this._fileToDataUrl(f);
          let obj = null;
          try { obj = await Assistant.extractBillImage(dataUrl); } catch (e) { obj = null; }
          if (!this._hasBillData(obj)) {
            note.textContent = '图片识别需先在「💬 AI 助手」里配置一个【带视觉】的大模型 API（如 GPT-4o、通义千问-VL）。未配置时请用【结构化录入】手工填写。';
            continue;
          }
          fields = obj;
        } else { // CSV / Excel / 文本：先按"电费单模板表格(多月)"解析，否则按自由文本
          let rows = null;
          try { rows = await this.readFileToRows(f); } catch (e) {}
          if (rows && rows.length) {
            const list = BillParser.parseTable(rows);
            if (list.length) { list.forEach(b => this.state.bills.push(b)); added += list.length; continue; }
          }
          const text = rows ? rows.map(r => r.join(' ')).join('\n') : await f.text();
          fields = await this._extractBill(text);
          if (!this._hasBillData(fields)) { note.textContent = `「${f.name}」未识别到电费单数据，请套用「电费单模板」或用结构化录入。`; continue; }
        }
        if (this._hasBillData(fields)) { this.state.bills.push(BillParser.fromFields(fields)); added++; }
      } catch (err) { note.textContent = '识别出错：' + (err.message || err); }
    }
    if (added) {
      note.textContent = `已识别并添加 ${added} 张电费单，已自动校准【2·用电与电价】`;
      this.renderBillList();
      this.applyBillCalibration(false);   // 自动把电费单口径写入第2节
    }
  },

  // 判断抽取结果是否含有效电费单数据
  _hasBillData(f) {
    if (!f) return false;
    const keys = ['total', 'maxDemand', 'peak', 'flat', 'valley', 'sharp', 'transformerKVA', 'totalFee'];
    return keys.some(k => { const v = parseFloat(f[k]); return isFinite(v) && v > 0; });
  },

  async parseBillPaste() {
    const text = document.getElementById('billPaste').value.trim();
    if (!text) { alert('请先粘贴电费单文字，或上传文件'); return; }
    const note = document.getElementById('billExtractNote');
    note.textContent = '识别中…';
    const fields = await this._extractBill(text);
    const bill = BillParser.fromFields(fields);
    this.fillBillForm(bill);
    document.getElementById('billFormWrap').open = true;
    if (this._hasBillData(fields)) {
      this.state.bills.push(bill);
      this.renderBillList();
      note.textContent = '已识别并自动校准【2·用电与电价】，可在下方表单核对修改。';
      this.applyBillCalibration(false);
    } else {
      note.textContent = '未能自动识别，请在下方【结构化录入】补全后「添加这张单」。';
    }
  },

  // 文本抽取：优先大模型，失败回退规则
  async _extractBill(text) {
    try {
      const obj = await Assistant.extractBillText(text);
      if (obj && Object.keys(obj).length) return obj;
    } catch (e) { /* 回退规则 */ }
    const b = BillParser.parseText(text);
    return { month: b.month, sharp: b.energy.sharp, peak: b.energy.peak, flat: b.energy.flat,
      valley: b.energy.valley, total: b.energy.total, maxDemand: b.maxDemand,
      transformerKVA: b.transformerKVA, basicFee: b.basicFee, energyFee: b.energyFee,
      totalFee: b.totalFee, powerFactor: b.powerFactor };
  },

  _fileToDataUrl(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result); r.onerror = () => rej(new Error('读取失败'));
      r.readAsDataURL(file);
    });
  },

  fillBillForm(bill) {
    const set = (id, v) => { document.getElementById(id).value = (v != null ? v : ''); };
    set('bf_month', bill.month); set('bf_sharp', bill.energy.sharp); set('bf_peak', bill.energy.peak);
    set('bf_flat', bill.energy.flat); set('bf_valley', bill.energy.valley); set('bf_total', bill.energy.total);
    set('bf_maxDemand', bill.maxDemand); set('bf_transformerKVA', bill.transformerKVA);
    set('bf_basicFee', bill.basicFee); set('bf_totalFee', bill.totalFee);
  },

  addBillFromForm() {
    const g = id => document.getElementById(id).value;
    const bill = BillParser.fromFields({
      month: g('bf_month'), sharp: g('bf_sharp'), peak: g('bf_peak'), flat: g('bf_flat'),
      valley: g('bf_valley'), total: g('bf_total'), maxDemand: g('bf_maxDemand'),
      transformerKVA: g('bf_transformerKVA'), basicFee: g('bf_basicFee'), totalFee: g('bf_totalFee')
    });
    if (!bill.energy.total && !bill.maxDemand) { alert('请至少填写总电量或最大需量'); return; }
    this.state.bills.push(bill);
    this.renderBillList();
    ['bf_month','bf_sharp','bf_peak','bf_flat','bf_valley','bf_total','bf_maxDemand','bf_transformerKVA','bf_basicFee','bf_totalFee']
      .forEach(id => { document.getElementById(id).value = ''; });
    this.applyBillCalibration(false);   // 录入后立即校准第2节
  },

  renderBillList() {
    const box = document.getElementById('billList');
    box.innerHTML = this.state.bills.map((b, i) => `
      <div class="bill-item">
        <span>${b.month ? b.month + '月' : '单张'} ｜ 电量 ${b.energy.total ? Math.round(b.energy.total).toLocaleString() : '—'} kWh ｜ 需量 ${b.maxDemand ? Math.round(b.maxDemand) + 'kW' : '—'} ｜ 电费 ${b.totalFee ? this.money(b.totalFee, '¥') : '—'}</span>
        <span class="x" data-bi="${i}">✕</span>
      </div>`).join('');
    box.querySelectorAll('.x').forEach(x => x.addEventListener('click', () => {
      this.state.bills.splice(+x.dataset.bi, 1); this.renderBillList();
    }));
  },

  applyBillCalibration(run) {
    if (run === undefined) run = true;
    if (!this.state.bills.length) {
      // 按钮触发但还没添加：尝试把表单内容纳入
      const g = id => document.getElementById(id).value;
      if (run && (g('bf_total') || g('bf_maxDemand'))) { this.addBillFromForm(); return; }
      if (run) alert('请先识别或录入至少一张电费单');
      return;
    }

    const loadCtx = {
      monthly: this.state.load.monthly.slice(),
      dataTier: this.state.load.dataTier,
      peakKw: parseFloat(document.getElementById('peakKw').value) || 0,
      transformerKVA: parseFloat(document.getElementById('transformerKVA').value) || 0,
      basicFeeMode: document.getElementById('basicFeeMode').value,
      measuredPeakKw: this.state.load.measuredPeakKw,     // 来自负荷表导入
      measuredAnnual: this.state.load.measuredAnnual
    };
    const r = BillParser.calibrate(this.state.bills, loadCtx);
    const cal = r.calibrated;
    if (cal) {
      this.state.load.monthly = cal.monthly.map(v => Math.round(v));
      this.renderMonths();
      if (cal.tou) {
        this.state.load.dataTier = 'tou';
        document.getElementById('dataTier').value = 'tou';
        document.getElementById('touSharp').value = Math.round(cal.tou.sharp * 100);
        document.getElementById('touPeak').value = Math.round(cal.tou.peak * 100);
        document.getElementById('touFlat').value = Math.round(cal.tou.flat * 100);
        document.getElementById('touValley').value = Math.round(cal.tou.valley * 100);
        this.updateLoadTierUI();
      }
      if (cal.peakKw) document.getElementById('peakKw').value = Math.round(cal.peakKw);
      if (cal.transformerKVA) document.getElementById('transformerKVA').value = Math.round(cal.transformerKVA);
      if (cal.basicFeeMode) document.getElementById('basicFeeMode').value = cal.basicFeeMode;
    }
    const noteEl = document.getElementById('billNote');
    noteEl.textContent = '电费单校准（计费真值）：\n· ' + r.notes.join('\n· ');
    noteEl.classList.remove('hidden');
    if (run) this.run();
  },

  downloadLoadTemplate() {
    const BOM = String.fromCharCode(0xFEFF);
    const rows = [['日期时间', '有功功率(kW)'],
      ['2024-01-01 00:15', '320.5'], ['2024-01-01 00:30', '318.2'],
      ['2024-01-01 00:45', '305.0'], ['2024-01-01 01:00', '300.1']];
    this._download(BOM + rows.map(r => r.join(',')).join('\n'),
      '负荷表模板_15分钟.csv', 'text/csv;charset=utf-8');
  },

  downloadBillTemplate() {
    const BOM = String.fromCharCode(0xFEFF);
    const header = ['计费月份', '尖峰电量(kWh)', '高峰电量(kWh)', '平段电量(kWh)', '低谷电量(kWh)',
      '总电量(kWh)', '最大需量(kW)', '变压器容量(kVA)', '基本电费(元)', '电费合计(元)'];
    const ex1 = ['7', '60000', '180000', '150000', '120000', '510000', '860', '2000', '34400', '392400'];
    const ex2 = ['8', '62000', '185000', '152000', '125000', '524000', '880', '2000', '35200', '402000'];
    this._download(BOM + [header, ex1, ex2].map(r => r.join(',')).join('\n'),
      '电费单模板_可多月.csv', 'text/csv;charset=utf-8');
  },

  showBillSample() {
    document.getElementById('billPaste').value =
      '计费月份：2024年7月\n受电容量：2000 kVA  最大需量：860 kW  功率因数：0.95\n' +
      '尖峰电量：60000 度  高峰电量：180000 度  平段电量：150000 度  低谷电量：120000 度\n' +
      '总用电量：510000 度\n基本电费：34400 元  电度电费：358000 元  电费合计：392400 元';
    document.getElementById('billExtractNote').textContent = '已填入示例文字，点"识别电费单"试试。';
  },

  // ============ 负荷表导入（Excel/CSV · 多文件 · 15 分钟数据） ============
  async onLoadFile(e) {
    const files = Array.from((e.target && e.target.files) || []);
    if (!files.length) return;
    const note = document.getElementById('importNote');
    note.textContent = '正在识别 ' + files.length + ' 个文件…';
    note.classList.remove('hidden');
    try {
      let allRows = [];
      const names = [];
      for (const f of files) {
        const rows = await this.readFileToRows(f);
        allRows = allRows.concat(rows);
        names.push(f.name);
      }
      this._importedRows = allRows;
      this._importedNames = names;
      document.getElementById('loadPaste').value = '';   // 文件优先，清空粘贴框
      this.parseLoadTable();
    } catch (err) {
      this._importedRows = null;
      note.textContent = '文件识别失败：' + (err.message || err) +
        '\n仅支持 .xlsx 与 CSV/TXT；旧版 .xls 请在 Excel 中"另存为" .xlsx 或 CSV。';
    }
  },

  // 把单个文件读成二维数组（xlsx 走解压解析；CSV/TXT 按分隔符拆分）
  async readFileToRows(file) {
    if (/\.xlsx$/i.test(file.name)) {
      const ab = await file.arrayBuffer();
      return await XlsxReader.read(ab);
    }
    const text = await file.text();
    const lines = String(text).replace(/\r/g, '').split('\n').filter(l => l.trim().length);
    const delim = LoadParser._detectDelim(lines);
    return lines.map(l => LoadParser._split(l, delim));
  },

  parseLoadTable() {
    const note = document.getElementById('importNote');
    const preview = document.getElementById('importPreview');
    const applyRow = document.getElementById('importApplyRow');
    const kind = document.getElementById('valueKindSel').value || undefined;
    let res, fromFiles = false;
    try {
      if (this._importedRows && this._importedRows.length) {
        res = LoadParser.parseRows(this._importedRows, { valueKind: kind });
        fromFiles = true;
      } else {
        const text = document.getElementById('loadPaste').value.trim();
        if (!text) { alert('请先选择 Excel/CSV 文件或粘贴负荷数据'); return; }
        res = LoadParser.parse(text, { valueKind: kind });
      }
    } catch (err) { res = { ok: false, error: err.message }; }

    if (!res.ok) {
      note.textContent = '识别失败：' + res.error;
      note.classList.remove('hidden');
      preview.classList.add('hidden'); applyRow.classList.add('hidden');
      return;
    }
    this._parsedLoad = res;
    const filePrefix = (fromFiles && this._importedNames && this._importedNames.length)
      ? `已导入 ${this._importedNames.length} 个文件：${this._importedNames.join('、')}\n` : '';
    note.textContent = filePrefix + res.note;
    note.classList.remove('hidden');

    const mx = Math.max.apply(null, res.hourly) || 1;
    const bars = res.hourly.map((v, i) =>
      `<div class="hbar" title="${i}时 ${Math.round(v)}kW" style="height:${Math.round(v / mx * 70) + 3}px"></div>`).join('');
    preview.innerHTML = '<div class="sublabel">逐时平均负荷（24h）</div>' +
      '<div class="hbars">' + bars + '</div>' +
      '<div class="hbars-cap"><span>0时</span><span>12时</span><span>23时</span></div>';
    preview.classList.remove('hidden');
    applyRow.classList.remove('hidden');
  },

  applyLoadTable() {
    const res = this._parsedLoad;
    if (!res) return;
    this.state.load.monthly = res.monthly.map(v => Math.round(v));
    const mx = Math.max.apply(null, res.hourly) || 1;
    this.state.load.hourly = res.hourly.map(v => +(v / mx).toFixed(3));   // 归一到 0~1
    this.state.load.dataTier = 'hourly';
    this.state.load.measuredPeakKw = res.peakKw;        // 供电费单交叉校验
    this.state.load.measuredAnnual = res.annualKwh;
    document.getElementById('dataTier').value = 'hourly';
    document.getElementById('peakKw').value = res.peakKw;
    this.renderMonths();
    this.renderHourly();
    this.updateLoadTierUI();
    // ③ AI 直接算出结果并显示在页面（自动测算 + 滚动到结果）
    this.run();
  },

  showLoadSample() {
    document.getElementById('loadPaste').value =
      '数据时间,有功功率(kW)\n' +
      '2024-01-01 00:15,320.5\n2024-01-01 00:30,318.2\n2024-01-01 00:45,305.0\n' +
      '2024-01-01 01:00,300.1\n2024-01-01 01:15,298.7';
    document.getElementById('importNote').textContent =
      '示例：第一列时间（含日期更准，可识别各月；仅时间则按典型日推算），第二列数值（有功功率 kW 或每 15 分钟电量 kWh）。支持逗号/制表符/分号/空格分隔，有无表头均可。';
    document.getElementById('importNote').classList.remove('hidden');
  },

  // ============ 测算 ============
  run() {
    try {
      // 若储能且为"自动反算"模式，先按当前负荷反算储能容量
      if (this.state.selected.storage && this.state.storageMode === 'auto') {
        this.doSizeStorage(false);
      }
      const cfg = this.buildConfig();
      if (!Object.values(cfg.selected).some(Boolean)) { alert('请至少选择一种设备'); return; }
      const ann = cfg.load.monthly ? cfg.load.monthly.reduce((a, b) => a + (+b || 0), 0) : (cfg.load.annualKwh || 0);
      if (!ann) { alert('请填写各月用电量（可用"均摊到 12 月"快速填写）'); return; }

      // 可研模式：先用组件级 PvModel 设定等效发电量，使现金流与发电精算一致
      let pvGen = null;
      if (this.engineeringOn() && cfg.selected.pv) {
        pvGen = this.computePv(cfg);
        if (pvGen) cfg.pvYieldEff = pvGen.nominalPerKw;
      }

      const result = Engine.run(cfg);
      this.state.lastResult = result;
      this.state.lastCfg = cfg;
      document.getElementById('results').classList.remove('hidden');
      this.renderResults(result);

      // 可研级财务评价
      const engBox = document.getElementById('engResults');
      if (this.engineeringOn()) {
        const f2 = this.runFinance2(cfg, result);
        this.renderEngineering(f2, pvGen, result);
        engBox.classList.remove('hidden');
      } else {
        engBox.classList.add('hidden');
      }
      document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      console.error(e);
      alert('测算出错：' + (e && e.message ? e.message : e));
    }
  },

  renderResults(r) {
    const f = r.finance;
    const cur = r.region.currency;
    const irr = f.irr !== null ? (f.irr * 100).toFixed(1) + '%' : '—';
    const payback = isFinite(f.paybackStatic) ? f.paybackStatic.toFixed(1) : '∞';
    const irrClass = f.irr === null ? 'bad' : (f.irr > 0.1 ? 'good' : f.irr > 0.05 ? 'warn' : 'bad');
    const pbClass = !isFinite(f.paybackStatic) ? 'bad' : (f.paybackStatic < 6 ? 'good' : f.paybackStatic < 9 ? 'warn' : 'bad');

    const kpis = [
      { label: '总投资', value: this.money(r.capex, cur), cls: '' },
      { label: '净现值 NPV', value: this.money(f.npv, cur), cls: f.npv > 0 ? 'good' : 'bad' },
      { label: '内部收益率 IRR', value: irr, cls: irrClass },
      { label: '静态回本期', value: payback, unit: '年', cls: pbClass },
      { label: '动态回本期', value: isFinite(f.paybackDynamic) ? f.paybackDynamic.toFixed(1) : '∞', unit: '年', cls: pbClass },
      { label: '平准度电成本', value: f.lcoe && isFinite(f.lcoe) ? f.lcoe.toFixed(3) : '—', unit: cur + '/kWh', cls: '' },
      { label: '年均净收益', value: this.money(f.avgAnnual, cur), cls: f.avgAnnual > 0 ? 'good' : 'bad' },
      { label: '全周期碳减排', value: Math.round(r.env.carbonCut).toLocaleString(), unit: 'tCO₂', cls: 'good' }
    ];
    document.getElementById('kpiGrid').innerHTML = kpis.map(k => `
      <div class="kpi ${k.cls}">
        <div class="label">${k.label}</div>
        <div class="value">${k.value}<span class="unit">${k.unit || ''}</span></div>
      </div>`).join('');

    // 负荷与两部制基本电费说明
    if (r.load) {
      const L = r.load, basisName = { demand: '按最大需量', capacity: '按变压器容量' };
      const basicSaving = (L.baselineBasicFee || 0) - (L.withBasicFee || 0);
      let note = `年用电量约 ${(L.annualKwh / 1e4).toFixed(0)} 万 kWh，最大需量约 ${Math.round(L.peakKw)} kW`;
      if (L.transformerKVA) note += `，变压器 ${Math.round(L.transformerKVA)} kVA`;
      note += `。\n基本电费（两部制）：基准 ${basisName[L.baselineBasis] || L.baselineBasis} ${this.money(L.baselineBasicFee, cur)}/年`;
      if (basicSaving > 1) note += `，储能削峰 ${Math.round(L.demandCut)} kW 后降至 ${this.money(L.withBasicFee, cur)}/年，年省 ${this.money(basicSaving, cur)}`;
      note += '。';
      let el = document.getElementById('loadNote');
      if (!el) {
        el = document.createElement('div');
        el.id = 'loadNote'; el.className = 'explain';
        document.getElementById('kpiGrid').insertAdjacentElement('afterend', el);
      }
      el.textContent = note;
    }

    this.drawCashflow(r);
    this.drawCapex(r);
    this.renderCashTable(r);
  },

  renderCashTable(r) {
    const cur = r.region.currency;
    const rows = r.finance.cashflows.map((cf, t) => {
      const cum = r.finance.cumulative[t];
      return `<tr>
        <td>${t === 0 ? '初始投资' : '第 ' + t + ' 年'}</td>
        <td class="${cf >= 0 ? 'pos' : 'neg'}">${this.money(cf, cur)}</td>
        <td class="${cum >= 0 ? 'pos' : 'neg'}">${this.money(cum, cur)}</td>
      </tr>`;
    }).join('');
    document.getElementById('cashTable').innerHTML =
      `<thead><tr><th>年度</th><th>当年现金流</th><th>累计现金流</th></tr></thead><tbody>${rows}</tbody>`;
  },

  // ============ 可研级评价编排 ============
  computePv(cfg) {
    if (typeof PvModel === 'undefined') return null;
    const g = id => document.getElementById(id);
    const tiltV = parseFloat(g('pvTilt').value);
    const moduleId = g('pvModuleSel').value;
    const mod = DEVICE_DB.pvModule(moduleId);
    // 让引擎逐年衰减与所选组件一致
    cfg.pv.degradationY1 = mod.degradeY1;
    cfg.pv.degradation = mod.degrade;
    const params = {
      regionKey: cfg.regionKey, capacityKw: cfg.pv.capacityKw,
      tilt: isFinite(tiltV) ? tiltV : undefined,
      azimuth: parseFloat(g('pvAzimuth').value) || 0,
      dcac: parseFloat(g('pvDcac').value) || 1.15,
      moduleId, year: 0
    };
    const g0 = PvModel.generate(params);
    const nominalPerKw = (g0.annual / (g0.detail.degrade || 1)) / (cfg.pv.capacityKw || 1);
    return Object.assign({}, g0, { nominalPerKw });
  },

  financeParams() {
    const num = id => parseFloat(document.getElementById(id).value);
    const equityRatio = (num('finEquity') || 30) / 100;
    const holiday = document.getElementById('taxHoliday').checked;
    return {
      financing: {
        loanRatio: Math.max(0, Math.min(1, 1 - equityRatio)),
        loanRate: (num('finRate') || 4.5) / 100,
        loanYears: num('finYears') || 15,
        grace: 0, repay: document.getElementById('finRepay').value, constructionMonths: 6
      },
      tax: {
        incomeTaxRate: (num('taxRate') || 25) / 100,
        freeYears: holiday ? 3 : 0, halfYears: holiday ? 3 : 0,
        vatRate: (num('vatRate') || 0) / 100, surchargeRate: 0.12
      },
      dep: { years: num('depYears') || 20, residualRate: (num('residualRate') || 5) / 100 }
    };
  },

  runFinance2(cfg, result) {
    const fp = this.financeParams();
    return Finance2.evaluate({
      staticInvestment: result.capex, years: result.years,
      revenueByYear: result.revenueByYear, omByYear: result.omByYear,
      replacementByYear: result.replacementByYear, generationByYear: result.generationByYear,
      financing: fp.financing, tax: fp.tax, dep: fp.dep, icList: [0.08, 0.06]
    });
  },

  renderEngineering(f2, pvGen, result) {
    const cur = result.region.currency;
    const kpi = (arr, id) => {
      document.getElementById(id).innerHTML = arr.map(k => `
        <div class="kpi ${k.cls || ''}"><div class="label">${k.label}</div>
        <div class="value">${k.value}<span class="unit">${k.unit || ''}</span></div></div>`).join('');
    };

    // 发电 P50/P90
    const genBox = document.getElementById('engGenKpi');
    if (pvGen) {
      kpi([
        { label: 'P50 年发电', value: (pvGen.p50 / 1e4).toFixed(1), unit: '万kWh' },
        { label: 'P90 年发电', value: (pvGen.p90 / 1e4).toFixed(1), unit: '万kWh' },
        { label: '系统效率 PR', value: (pvGen.pr * 100).toFixed(1) + '%', cls: 'good' },
        { label: '等效利用小时', value: pvGen.hours, unit: 'h' },
        { label: '阵列倾角', value: pvGen.detail.tilt, unit: '°' }
      ], 'engGenKpi');
    } else {
      genBox.innerHTML = '<div class="hint">本方案未含光伏。</div>';
    }

    const I = f2.indicators;
    kpi([
      { label: '总投资(动态)', value: this.money(f2.totalInvestment, cur) },
      { label: '其中资本金', value: this.money(f2.equity, cur) },
      { label: '项目 IRR', value: I.projectIRR !== null ? (I.projectIRR * 100).toFixed(2) + '%' : '—', cls: 'good' },
      { label: '资本金 IRR', value: I.equityIRR !== null ? (I.equityIRR * 100).toFixed(2) + '%' : '—', cls: 'good' },
      { label: 'NPV@8%', value: this.money(I.npv['0.08'], cur), cls: I.npv['0.08'] > 0 ? 'good' : 'bad' },
      { label: 'NPV@6%', value: this.money(I.npv['0.06'], cur), cls: I.npv['0.06'] > 0 ? 'good' : 'bad' },
      { label: '静态回收', value: isFinite(I.paybackStatic) ? I.paybackStatic.toFixed(1) : '∞', unit: '年' },
      { label: 'LCOE', value: I.lcoe && isFinite(I.lcoe) ? I.lcoe.toFixed(3) : '—', unit: cur + '/kWh' },
      { label: '最小 DSCR', value: I.dscr.min != null ? I.dscr.min.toFixed(2) : '—', cls: (I.dscr.min || 0) >= 1.2 ? 'good' : 'warn' },
      { label: '最小 ICR', value: I.icr.min != null ? I.icr.min.toFixed(2) : '—' }
    ], 'engFinKpi');

    // 利润表
    const inc = f2.income.map(a => `<tr>
      <td>第${a.year}年</td><td>${this.money(a.revenue, cur)}</td><td>${this.money(a.dep, cur)}</td>
      <td>${this.money(a.interest, cur)}</td><td>${(a.taxRate * 100).toFixed(0)}%</td>
      <td>${this.money(a.tax, cur)}</td><td class="${a.netProfit >= 0 ? 'pos' : 'neg'}">${this.money(a.netProfit, cur)}</td></tr>`).join('');
    document.getElementById('engIncomeTable').innerHTML =
      `<thead><tr><th>年度</th><th>营业收入</th><th>折旧</th><th>利息</th><th>税率</th><th>所得税</th><th>净利润</th></tr></thead><tbody>${inc}</tbody>`;

    // 现金流量表
    let cumP = -f2.totalInvestment, cumE = -f2.equity;
    const cf = f2.cashflowProject.map((p, i) => {
      cumP += p; cumE += f2.cashflowEquity[i];
      return `<tr><td>第${i + 1}年</td>
        <td class="${p >= 0 ? 'pos' : 'neg'}">${this.money(p, cur)}</td><td>${this.money(cumP, cur)}</td>
        <td class="${f2.cashflowEquity[i] >= 0 ? 'pos' : 'neg'}">${this.money(f2.cashflowEquity[i], cur)}</td><td>${this.money(cumE, cur)}</td></tr>`;
    }).join('');
    document.getElementById('engCashTable').innerHTML =
      `<thead><tr><th>年度</th><th>项目现金流</th><th>累计</th><th>资本金现金流</th><th>累计</th></tr></thead><tbody>${cf}</tbody>`;

    // 敏感性
    const sens = f2.sensitivity.map(s => `<tr><td>${s.factor}</td>
      <td>${s.irrLo !== null ? (s.irrLo * 100).toFixed(2) + '%' : '—'}</td>
      <td>${s.irrHi !== null ? (s.irrHi * 100).toFixed(2) + '%' : '—'}</td></tr>`).join('');
    document.getElementById('engSensTable').innerHTML =
      `<thead><tr><th>因素</th><th>-10% 时</th><th>+10% 时</th></tr></thead><tbody>${sens}</tbody>`;
  },

  // ============ 优化 ============
  runOptimize() {
    const base = this.buildConfig({ mode: 'simplified' });
    const ann = base.load.monthly ? base.load.monthly.reduce((a, b) => a + (+b || 0), 0) : (base.load.annualKwh || 0);
    if (!ann) { alert('请先在"方案测算"页填写各月用电量'); return; }
    const cons = {
      budget: this.val('optBudget') ? this.val('optBudget') * 1e4 : null,
      areaM2: this.val('optArea') || null,
      objective: document.getElementById('optObjective').value
    };
    const prog = document.getElementById('optProgress');
    prog.classList.remove('hidden');
    const bar = prog.querySelector('.bar');

    setTimeout(() => {
      const out = Optimizer.optimizeCapacity(base, cons, (p) => { bar.style.width = (p * 100) + '%'; });
      bar.style.width = '100%';
      this.lastOpt = out;
      this.renderOptResults(out, REGIONS[base.regionKey].currency);
      setTimeout(() => prog.classList.add('hidden'), 400);
    }, 50);
  },

  renderOptResults(out, cur) {
    document.getElementById('optResults').classList.remove('hidden');
    document.getElementById('optExplain').textContent = out.explain;
    if (!out.best) { document.getElementById('optKpi').innerHTML = ''; return; }
    const f = out.best.result.finance;
    const kpis = [
      { label: '推荐光伏', value: Math.round(out.best.pvKw).toLocaleString(), unit: 'kW' },
      { label: '推荐储能', value: Math.round(out.best.storeKwh).toLocaleString(), unit: 'kWh' },
      { label: '总投资', value: this.money(out.best.capex, cur) },
      { label: '净现值', value: this.money(f.npv, cur), cls: f.npv > 0 ? 'good' : 'bad' },
      { label: 'IRR', value: f.irr !== null ? (f.irr * 100).toFixed(1) + '%' : '—', cls: 'good' },
      { label: '回本期', value: isFinite(f.paybackStatic) ? f.paybackStatic.toFixed(1) : '∞', unit: '年' }
    ];
    document.getElementById('optKpi').innerHTML = kpis.map(k => `
      <div class="kpi ${k.cls || ''}"><div class="label">${k.label}</div>
      <div class="value">${k.value}<span class="unit">${k.unit || ''}</span></div></div>`).join('');
  },

  applyOpt() {
    if (!this.lastOpt || !this.lastOpt.best) return;
    const b = this.lastOpt.best;
    if (b.pvKw > 0) { this.state.params.pv.capacityKw = Math.round(b.pvKw); this.state.selected.pv = true; }
    if (b.storeKwh > 0) {
      this.state.params.storage.capacityKwh = Math.round(b.storeKwh);
      this.state.params.storage.powerKw = Math.round(b.storeKw);
      this.state.selected.storage = true;
    }
    this.renderDeviceToggles();
    this.renderParamForms();
    document.querySelector('.tab[data-tab="calc"]').click();
    this.run();
  },

  runDispatch() {
    const base = this.buildConfig({ mode: 'simplified' });
    if (!base.selected.storage) { alert('请先选择储能设备'); return; }
    const out = Optimizer.optimizeDispatch(base);
    const cur = REGIONS[base.regionKey].currency;
    document.getElementById('dispatchResults').classList.remove('hidden');
    const rows = out.all.map(s => `<tr>
      <td>${s.label}${s.key === out.best.key ? ' ✅' : ''}</td>
      <td>${this.money(s.npv, cur)}</td>
      <td>${s.irr !== null ? (s.irr * 100).toFixed(1) + '%' : '—'}</td>
      <td>${(s.payback != null && isFinite(s.payback)) ? s.payback.toFixed(1) + ' 年' : '∞'}</td>
    </tr>`).join('');
    document.getElementById('dispatchTable').innerHTML =
      `<thead><tr><th>策略</th><th>净现值</th><th>IRR</th><th>回本期</th></tr></thead><tbody>${rows}</tbody>`;
  },

  // ============ 助手 ============
  async sendChat() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;
    this.addMsg('user', text);
    input.value = '';
    const thinking = this.addMsg('bot', '正在测算…');
    const fallback = this.buildConfig();
    let res;
    try {
      res = await Assistant.recommend(text, fallback);
    } catch (e) {
      thinking.textContent = '出错了：' + e.message;
      return;
    }
    thinking.remove();
    const botMsg = this.addMsg('bot', res.reply);
    // 若有推荐方案，加"应用"按钮
    if (res.recommendation && res.recommendation.best) {
      const btn = document.createElement('button');
      btn.className = 'btn-secondary apply-btn';
      btn.textContent = '↧ 应用此方案';
      btn.onclick = () => {
        this.lastOpt = res.recommendation;
        // 同步地区/负荷到表单
        document.getElementById('regionSelect').value = res.parsed.regionKey || fallback.regionKey;
        if (res.load) {
          const per = Math.round((res.load.annualKwh || 0) / 12);
          this.state.load.monthly = new Array(12).fill(per);
          this.renderMonths();
          document.getElementById('peakKw').value = Math.round(res.load.peakKw || 0);
          document.getElementById('loadProfile').value = res.load.profile;
        }
        Object.assign(this.state.selected, res.parsed.devices);
        this.updateStorageSizingUI();
        this.applyOpt();
      };
      botMsg.appendChild(btn);
    }
    document.getElementById('chatBox').scrollTop = 1e9;
  },

  addMsg(role, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.textContent = text;
    document.getElementById('chatBox').appendChild(div);
    document.getElementById('chatBox').scrollTop = 1e9;
    return div;
  },

  // ============ 图表（原生 Canvas，零依赖） ============
  drawCashflow(r) {
    const cv = document.getElementById('cashflowChart');
    const ctx = cv.getContext('2d');
    const W = cv.width = cv.clientWidth, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const data = r.finance.cumulative;
    const pad = { l: 56, r: 12, t: 14, b: 24 };
    const max = Math.max(...data, 0), min = Math.min(...data, 0);
    const range = (max - min) || 1;
    const x = i => pad.l + (W - pad.l - pad.r) * i / (data.length - 1);
    const y = v => pad.t + (H - pad.t - pad.b) * (1 - (v - min) / range);

    // 零轴
    ctx.strokeStyle = '#3a4a70'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, y(0)); ctx.lineTo(W - pad.r, y(0)); ctx.stroke();
    // 网格 y 标签
    ctx.fillStyle = '#93a1c0'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
    [max, (max + min) / 2, min].forEach(v => {
      ctx.fillText(this.shortMoney(v), pad.l - 6, y(v) + 3);
    });
    // 面积
    const grad = ctx.createLinearGradient(0, pad.t, 0, H);
    grad.addColorStop(0, 'rgba(34,197,94,.35)'); grad.addColorStop(1, 'rgba(34,197,94,0)');
    ctx.beginPath(); ctx.moveTo(x(0), y(0));
    data.forEach((v, i) => ctx.lineTo(x(i), y(v)));
    ctx.lineTo(x(data.length - 1), y(0)); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    // 线
    ctx.beginPath();
    data.forEach((v, i) => i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v)));
    ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 2.2; ctx.stroke();
    // x 标签
    ctx.fillStyle = '#93a1c0'; ctx.textAlign = 'center';
    for (let i = 0; i < data.length; i += Math.ceil(data.length / 6)) {
      ctx.fillText(i + 'y', x(i), H - 8);
    }
  },

  drawCapex(r) {
    const cv = document.getElementById('capexChart');
    const ctx = cv.getContext('2d');
    const W = cv.width = cv.clientWidth, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const colors = { pv: '#f59e0b', storage: '#22c55e', charger: '#06b6d4', diesel: '#a855f7' };
    const names = { pv: '光伏', storage: '储能', charger: '充电桩', diesel: '柴发' };
    const entries = Object.entries(r.capexBreakdown).filter(([, v]) => v > 0);
    const total = entries.reduce((a, [, v]) => a + v, 0) || 1;
    const cx = W / 2, cy = H / 2, rad = Math.min(W, H) / 2 - 14;
    let ang = -Math.PI / 2;
    entries.forEach(([k, v]) => {
      const slice = v / total * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, rad, ang, ang + slice); ctx.closePath();
      ctx.fillStyle = colors[k]; ctx.fill();
      ang += slice;
    });
    // 中心挖空
    ctx.beginPath(); ctx.arc(cx, cy, rad * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = '#1c2742'; ctx.fill();
    ctx.fillStyle = '#e8edf7'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(this.shortMoney(total), cx, cy + 4);

    document.getElementById('capexLegend').innerHTML = entries.map(([k, v]) =>
      `<div class="item"><span class="dot" style="background:${colors[k]}"></span>
       ${names[k]} ${(v / total * 100).toFixed(0)}%</div>`).join('');
  },

  // ============ 工具 ============
  reset() {
    this.state.params = JSON.parse(JSON.stringify(DEVICE_DEFAULTS));
    this.renderParamForms();
  },
  val(id) { const v = parseFloat(document.getElementById(id).value); return isNaN(v) ? 0 : v; },
  money(n, cur = '¥') {
    const s = n < 0 ? '-' : '';
    n = Math.abs(n);
    if (n >= 1e8) return s + cur + (n / 1e8).toFixed(2) + '亿';
    if (n >= 1e4) return s + cur + (n / 1e4).toFixed(1) + '万';
    return s + cur + Math.round(n).toLocaleString('zh-CN');
  },
  shortMoney(n) {
    const s = n < 0 ? '-' : ''; n = Math.abs(n);
    if (n >= 1e8) return s + (n / 1e8).toFixed(1) + '亿';
    if (n >= 1e4) return s + (n / 1e4).toFixed(0) + '万';
    return s + Math.round(n);
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
