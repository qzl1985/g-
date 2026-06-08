# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

新能源投资测算软件 — a renewable-energy investment calculator. Pure front-end,
zero-dependency, runs by opening `index.html` (no build step). Models 光伏 (PV),
储能 (storage), 充电桩 (chargers), 柴油发电机 (diesel), selectable individually or
in any combination, plus AI capacity optimization, dispatch strategy optimization,
forecasting, and a Chinese conversational assistant.

## Run / test

- **Run**: open `index.html` directly, or `python3 -m http.server 8000` then visit
  `http://localhost:8000` (preferred — avoids `file://` quirks).
- **Syntax check**: `node --check js/*.js`
- **Logic tests (no browser)**: the business modules attach their APIs as
  top-level `const`/`var` globals AND `module.exports`. To test in Node, load all
  `js/*.js` (except `app.js`, which is DOM-bound) into a single shared
  `vm` context so cross-file global references resolve, then call
  `Engine.run` / `Optimizer.*` / `Assistant.*`. Stub `App.buildConfig` inside the
  same context (assistant depends on it). Wrap each test in an IIFE to avoid
  `const` redeclaration across `runInContext` calls.

## Architecture

Layered, DOM-decoupled. Scripts load in dependency order (see bottom of
`index.html`); each file defines globals consumed by later files:

- `js/data.js` — data layer: `REGIONS` (TOU tariffs, PV yield, policy),
  `DEVICE_DEFAULTS`, `LOAD_PROFILES`, `PV_PROFILE_BASE`, `MONTHLY_IRRADIANCE`.
  **Every region's `tou.schedule` MUST have exactly 24 entries** (one per hour);
  a short array silently produced NaN before a guard was added in `engine.priceAt`.
  Two-part tariff: regions carry both `demandCharge` (元/kW/月, by max demand)
  and `capacityCharge` (元/kVA/月, by transformer capacity).
- `js/finance.js` — `Finance`: NPV, IRR (bisection), static/dynamic payback,
  LCOE, `summarize()`.
- `js/devicedb.js` — `DEVICE_DB`: PV module / inverter / battery model library +
  standard transformer kVA series (`pickTransformer`).
- `js/weather.js` — `Weather`: per-region approximate TMY (annual GHI, monthly
  distribution, ambient temp, year-to-year σ) + tilted-plane POA transposition.
- `js/pvmodel.js` — `PvModel.generate(p)`: component-level PV output (temp coef/
  NOCT/DCAC/inverter eff/system losses) → monthly/annual gen, PR, equiv hours,
  **P50/P90**. `generateYears` for multi-year with degradation. Depends on
  Weather + DEVICE_DB.
- `js/finance2.js` — `Finance2.evaluate(p)`: 可研-grade财务 — IDC, loan schedule
  (equal-principal/payment), depreciation, income tax (三免三减半), income/
  cashflow/balance statements, **project & equity IRR**, dual-ic NPV, DSCR/ICR,
  LCOE, single-factor sensitivity. Depends on Finance.
- `js/engine.js` — `Engine`: device modeling + hourly storage dispatch
  (`dispatchDay`) + `run(cfg)`. Dual precision via `mode`:
  `simplified` (1 representative day ×365) vs `professional` (12 months ×
  monthly irradiance). `cfg.load` carries `monthly[12]` (kWh per month),
  `dataTier` (`template`/`tou`/`hourly` — see `buildLoadDay`), `transformerKVA`,
  `peakKw`, `basicFeeMode` (`auto`/`demand`/`capacity`). `basicFee()` computes
  two-part basic charge; storage demand-shaving only reduces it under demand
  basis. Accepts `cfg.pvYieldEff` (kWh/kW·yr from PvModel) to override the
  region constant. Returns capex breakdown, per-year cashflow, finance, env, a
  `load` summary, plus `revenueByYear`/`replacementByYear`/`generationByYear`
  (consumed by Finance2 in 可研 mode).
- `js/optimizer.js` — `Optimizer`: `optimizeCapacity` (grid search + local
  refine), `optimizeDispatch` (compares 3 storage strategies), and
  `sizeStorage(cfg)` — back-calculates recommended storage kWh/kW from the load
  curve (valley-charge / peak-discharge, one cycle/day). Used by the UI's
  "AI auto-size storage" mode.
- `js/forecast.js` — `Forecast`: reverse-estimate annual kWh / peak from
  bill or peak; predict PV generation.
- `js/loadparser.js` — `LoadParser.parse(text, opts)` / `parseRows(rows, opts)`:
  zero-dep parser for utility 15-min (or 5/10/30/60-min) load tables (CSV,
  pasted, or rows from xlsx). Auto-detects delimiter, header, timestamp/value
  columns, interval, kW-vs-kWh, and Excel serial dates. Returns annualKwh,
  monthly[12], real peak demand (kW), and a 24h average load shape — fed into
  the form (dataTier `hourly`). Multiple files are concatenated into one
  `parseRows` call (aggregated by date).
- `js/billparser.js` — `BillParser`: Chinese 电费单 parsing (`parseText` regex,
  `fromFields` for LLM/manual input) + `calibrate(bills, load)` — **bill is the
  billing ground truth**: sets monthly kWh, TOU shares (dataTier `tou`), max
  demand, transformer kVA, basic-fee basis from bills; cross-checks against the
  load table's measured peak/annual and warns on >15%/10% discrepancy.
- `js/pdfreader.js` — `PdfReader.extractText(arrayBuffer)` → `Promise<{text,via}>`:
  lazy-loads pdf.js from CDN for reliable (incl. Chinese) text PDFs, falls back
  to a zero-dep extractor (inflate FlateDecode via DecompressionStream + Tj/TJ
  ops). Scanned/image PDFs have no text layer → UI routes to LLM vision / manual.
- `js/xlsx.js` — `XlsxReader.read(arrayBuffer)` → `Promise<string[][]>`:
  zero-dep .xlsx reader. Parses the ZIP central directory, inflates entries via
  the built-in `DecompressionStream('deflate-raw')`, and regex-parses the first
  worksheet + sharedStrings (no DOMParser). Feature-detect with `supported()`.
- `js/assistant.js` — `Assistant`: Chinese NL parse (`parse`) + end-to-end
  `recommend`. Depends on global `App.buildConfig`. `callLLM` is an optional
  hook for swapping in a real LLM.
- `js/app.js` — `App`: UI orchestration, form state, Canvas charts (no chart
  lib). `App.buildConfig(overrides)` is the single config assembler shared by
  calc / optimize / assistant.

## Conventions

- All UI text and domain terminology is in Chinese (zh-CN).
- Currency/units: costs in 元 unless region currency differs; capex inputs use
  元/W (PV, diesel) and 元/Wh (storage); engine converts via ×1000.
- Keep modules DOM-free except `app.js`. New business logic should be testable
  in the `vm` harness above.
- No external runtime dependencies — keep it zero-dependency and build-free.
