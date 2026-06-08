/**
 * finance2.js — 可研级财务评价（模块C · 对标《建设项目经济评价方法与参数·第三版》）
 *
 * 在 Finance(基础NPV/IRR) 之上，构建：建设期利息、融资与还款计划、折旧、
 * 企业所得税(三免三减半)、利润表/现金流量表/资产负债表三大报表，
 * 项目IRR与资本金IRR、双基准NPV、DSCR/ICR、LCOE、单因素敏感性。
 *
 * 依赖：Finance（全局）。DOM-free，可在 vm 测试。
 */

const Finance2 = {
  /**
   * @param {object} p
   *  staticInvestment 静态总投资
   *  years 运营期
   *  revenueByYear[] 营业收入(电费节省+上网+服务费+其它)
   *  omByYear[] 运营成本(运维/保险/人工/租金)
   *  replacementByYear[] 设备更换现金流出(储能等)
   *  generationByYear[] 年供电量(用于LCOE)
   *  financing { loanRatio, loanRate, loanYears, grace, repay('equal-principal'|'equal-payment'), constructionMonths }
   *  tax { incomeTaxRate, freeYears, halfYears, vatRate, surchargeRate }
   *  dep { years, residualRate }
   *  icList [0.08, 0.06]
   */
  evaluate(p) {
    const years = p.years;
    const fin = Object.assign({ loanRatio: 0.7, loanRate: 0.045, loanYears: 15, grace: 0,
      repay: 'equal-principal', constructionMonths: 6 }, p.financing || {});
    const tax = Object.assign({ incomeTaxRate: 0.25, freeYears: 3, halfYears: 3,
      vatRate: 0, surchargeRate: 0.12 }, p.tax || {});
    const dep = Object.assign({ years: 20, residualRate: 0.05 }, p.dep || {});
    const icList = p.icList || [0.08, 0.06];

    const rev = p.revenueByYear, om = p.omByYear;
    const repl = p.replacementByYear || new Array(years).fill(0);
    const gen = p.generationByYear || new Array(years).fill(0);

    // ---- 投资与融资 ----
    const staticInv = p.staticInvestment;
    const loan = staticInv * fin.loanRatio;
    // 建设期利息 IDC（按建设期半程平均占用近似）
    const idc = loan * fin.loanRate * (fin.constructionMonths / 12) / 2;
    const totalInvestment = staticInv + idc;
    const equity = totalInvestment - loan;
    const residual = staticInv * dep.residualRate;

    const loanSched = this._loanSchedule(loan, fin.loanRate, fin.loanYears, fin.grace, fin.repay, years);
    const depBase = totalInvestment * (1 - dep.residualRate);
    const depByYear = [];
    for (let y = 1; y <= years; y++) depByYear.push(y <= dep.years ? depBase / dep.years : 0);

    // ---- 逐年三表 ----
    const income = [], cashProject = [], cashEquity = [], balance = [];
    let cumDep = 0, loanBal = loan, retainedEarnings = 0;

    for (let y = 1; y <= years; y++) {
      const i = y - 1;
      const revenue = rev[i] || 0;
      const omc = om[i] || 0;
      const depc = depByYear[i] || 0;
      const interest = loanSched[i] ? loanSched[i].interest : 0;
      const principal = loanSched[i] ? loanSched[i].principal : 0;
      const replc = repl[i] || 0;

      const ebitda = revenue - omc;
      const ebit = ebitda - depc;
      const ebt = ebit - interest;
      const rate = this._effTaxRate(y, tax);
      const taxActual = rate * Math.max(0, ebt);
      const taxProject = rate * Math.max(0, ebit);
      // 简化增值税附加（默认 vatRate=0 时为 0）
      const vatPayable = Math.max(0, revenue * tax.vatRate);
      const surcharge = vatPayable * tax.surchargeRate;
      const netProfit = ebt - taxActual - surcharge;

      const residY = (y === years) ? residual : 0;
      const projectCF = ebitda - taxProject - surcharge - replc + residY;
      const equityCF = ebitda - interest - principal - taxActual - surcharge - replc + residY;

      // 偿债备付率/利息备付率
      const debtSvc = interest + principal;
      const dscr = debtSvc > 0 ? (netProfit + depc + interest) / debtSvc : null;
      const icr = interest > 0 ? ebit / interest : null;

      cumDep += depc;
      loanBal = loanSched[i] ? loanSched[i].balance : 0;
      retainedEarnings += netProfit;

      income.push({ year: y, revenue, om: omc, dep: depc, ebit, interest, ebt,
        tax: taxActual + surcharge, netProfit, taxRate: rate });
      cashProject.push(projectCF);
      cashEquity.push(equityCF);
      balance.push({ year: y,
        fixedAssetNet: Math.max(0, totalInvestment - cumDep),
        loanBalance: loanBal,
        equity: equity + retainedEarnings,
        dscr, icr });
    }

    // ---- 指标 ----
    const projSeries = [-totalInvestment, ...cashProject];
    const eqSeries = [-equity, ...cashEquity];
    const projectIRR = Finance.irr(projSeries);
    const equityIRR = Finance.irr(eqSeries);
    const npv = {};
    icList.forEach(ic => { npv[ic] = Finance.npv(ic, projSeries); });
    const paybackStatic = Finance.paybackStatic(projSeries);
    const paybackDynamic = Finance.paybackDynamic(icList[0], projSeries);

    // LCOE（以首个基准折现）
    const ic0 = icList[0];
    let costPV = totalInvestment, genPV = 0;
    for (let y = 1; y <= years; y++) {
      const d = Math.pow(1 + ic0, y);
      costPV += ((om[y - 1] || 0) + (repl[y - 1] || 0)) / d;
      genPV += (gen[y - 1] || 0) / d;
    }
    const lcoe = genPV > 0 ? costPV / genPV : null;

    const dscrs = balance.map(b => b.dscr).filter(v => v != null && isFinite(v));
    const icrs = balance.map(b => b.icr).filter(v => v != null && isFinite(v));
    const totalNet = cashProject.reduce((a, b) => a + b, 0);

    return {
      totalInvestment, staticInvestment: staticInv, idc, loan, equity, residual,
      loanSchedule: loanSched, depByYear,
      income, cashflowProject: cashProject, cashflowEquity: cashEquity, balance,
      indicators: {
        projectIRR, equityIRR, npv,
        paybackStatic, paybackDynamic, lcoe,
        dscr: { min: dscrs.length ? Math.min.apply(null, dscrs) : null,
                avg: dscrs.length ? dscrs.reduce((a, b) => a + b, 0) / dscrs.length : null },
        icr: { min: icrs.length ? Math.min.apply(null, icrs) : null,
               avg: icrs.length ? icrs.reduce((a, b) => a + b, 0) / icrs.length : null },
        roi: totalInvestment > 0 ? totalNet / totalInvestment : 0
      },
      sensitivity: this._sensitivity(p)
    };
  },

  // 还款计划（支持宽限期、等额本金/等额本息）
  _loanSchedule(loan, rate, nYears, grace, method, opYears) {
    const sched = [];
    let bal = loan;
    let annuity = 0;
    if (method === 'equal-payment' && rate > 0) {
      annuity = loan * rate / (1 - Math.pow(1 + rate, -nYears));
    }
    for (let y = 1; y <= opYears; y++) {
      let interest = 0, principal = 0;
      if (y <= grace) {
        interest = bal * rate;
      } else if (y <= grace + nYears) {
        interest = bal * rate;
        principal = (method === 'equal-payment') ? (annuity - interest) : (loan / nYears);
        if (principal > bal) principal = bal;
        bal -= principal;
      }
      sched.push({ year: y, interest, principal, balance: Math.max(0, bal) });
    }
    return sched;
  },

  _effTaxRate(y, tax) {
    if (y <= tax.freeYears) return 0;
    if (y <= tax.freeYears + tax.halfYears) return tax.incomeTaxRate / 2;
    return tax.incomeTaxRate;
  },

  // 单因素敏感性：营业收入 / 静态投资 / 贷款利率 各 ±10% → 项目&资本金 IRR
  _sensitivity(p) {
    const factors = [
      { key: 'revenue', name: '营业收入' },
      { key: 'invest', name: '静态投资' },
      { key: 'loanRate', name: '贷款利率' }
    ];
    const base = (mods) => {
      const q = JSON.parse(JSON.stringify({
        staticInvestment: p.staticInvestment, years: p.years,
        revenueByYear: p.revenueByYear, omByYear: p.omByYear,
        replacementByYear: p.replacementByYear, generationByYear: p.generationByYear,
        financing: p.financing, tax: p.tax, dep: p.dep, icList: p.icList
      }));
      if (mods.revenue) q.revenueByYear = q.revenueByYear.map(v => v * mods.revenue);
      if (mods.invest) q.staticInvestment *= mods.invest;
      if (mods.loanRate) { q.financing = q.financing || {}; q.financing.loanRate = (q.financing.loanRate || 0.045) * mods.loanRate; }
      const r = this._evalCore(q);
      return r;
    };
    return factors.map(f => {
      const lo = base({ [f.key === 'loanRate' ? 'loanRate' : (f.key === 'invest' ? 'invest' : 'revenue')]: 0.9 });
      const hi = base({ [f.key === 'loanRate' ? 'loanRate' : (f.key === 'invest' ? 'invest' : 'revenue')]: 1.1 });
      return { factor: f.name,
        irrLo: lo.projectIRR, irrHi: hi.projectIRR,
        eqIrrLo: lo.equityIRR, eqIrrHi: hi.equityIRR };
    });
  },

  // 敏感性内部用：只算关键指标，避免递归调用 sensitivity
  _evalCore(p) {
    const saved = this._sensitivity;
    this._sensitivity = () => [];
    const r = this.evaluate(p);
    this._sensitivity = saved;
    return { projectIRR: r.indicators.projectIRR, equityIRR: r.indicators.equityIRR };
  }
};

if (typeof module !== 'undefined') module.exports = { Finance2 };
