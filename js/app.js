/**
 * app.js — 界面交互与编排
 * 连接数据/引擎/优化/预测/助手，处理表单、渲染结果、绘制图表。
 */

const App = {
  state: {
    selected: { pv: true, storage: true, charger: false, diesel: false },
    params: JSON.parse(JSON.stringify(DEVICE_DEFAULTS)),
    lastResult: null
  },

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
    this.fillRegions();
    this.fillLoadProfiles();
    this.renderDeviceToggles();
    this.renderParamForms();
    this.bindEvents();
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
      }, 0);
    });

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
      load: o.load || {
        annualKwh: parseFloat(document.getElementById('annualKwh').value) || 0,
        peakKw: parseFloat(document.getElementById('peakKw').value) || 0,
        profile: document.getElementById('loadProfile').value
      },
      discountRate: o.discountRate ?? (parseFloat(document.getElementById('discountRate').value) / 100 || 0.06),
      projectYears: o.projectYears || parseInt(document.getElementById('projectYears').value) || 25,
      strategy: o.strategy || ['arbitrage', 'demand'],
      dispatchMode: o.dispatchMode || 'arbitrage'
    };
    // 自动补峰值
    if (!cfg.load.peakKw && cfg.load.annualKwh) {
      cfg.load.peakKw = Forecast.estimatePeakKw(cfg.load.annualKwh, cfg.load.profile);
    }
    // 应用 overrides 中的设备容量
    if (o.pv) Object.assign(cfg.pv, o.pv);
    if (o.storage) Object.assign(cfg.storage, o.storage);
    return cfg;
  },

  // ============ 测算 ============
  run() {
    const cfg = this.buildConfig();
    if (!Object.values(cfg.selected).some(Boolean)) { alert('请至少选择一种设备'); return; }
    if (!cfg.load.annualKwh) { alert('请填写年用电量'); return; }
    const result = Engine.run(cfg);
    this.state.lastResult = result;
    this.renderResults(result);
    document.getElementById('results').classList.remove('hidden');
    document.getElementById('results').scrollIntoView({ behavior: 'smooth' });
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

  // ============ 优化 ============
  runOptimize() {
    const base = this.buildConfig({ mode: 'simplified' });
    if (!base.load.annualKwh) { alert('请先在"方案测算"页填写年用电量'); return; }
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
      this.renderOptResults(out, base.region.currency);
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
    const cur = base.region.currency;
    document.getElementById('dispatchResults').classList.remove('hidden');
    const rows = out.all.map(s => `<tr>
      <td>${s.label}${s.key === out.best.key ? ' ✅' : ''}</td>
      <td>${this.money(s.npv, cur)}</td>
      <td>${s.irr !== null ? (s.irr * 100).toFixed(1) + '%' : '—'}</td>
      <td>${isFinite(s.payback) ? s.payback.toFixed(1) + ' 年' : '∞'}</td>
    </tr>`).join('');
    document.getElementById('dispatchTable').innerHTML =
      `<thead><tr><th>策略</th><th>净现值</th><th>IRR</th><th>回本期</th></tr></thead><tbody>${rows}</tbody>`;
  },

  // ============ 助手 ============
  sendChat() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;
    this.addMsg('user', text);
    input.value = '';
    const fallback = this.buildConfig();
    const res = Assistant.recommend(text, fallback);
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
          document.getElementById('annualKwh').value = Math.round(res.load.annualKwh);
          document.getElementById('peakKw').value = Math.round(res.load.peakKw);
          document.getElementById('loadProfile').value = res.load.profile;
        }
        Object.assign(this.state.selected, res.parsed.devices);
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
