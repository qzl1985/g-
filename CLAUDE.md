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
- `js/engine.js` — `Engine`: device modeling + hourly storage dispatch
  (`dispatchDay`) + `run(cfg)`. Dual precision via `mode`:
  `simplified` (1 representative day ×365) vs `professional` (12 months ×
  monthly irradiance). `cfg.load` carries `monthly[12]` (kWh per month),
  `dataTier` (`template`/`tou`/`hourly` — see `buildLoadDay`), `transformerKVA`,
  `peakKw`, `basicFeeMode` (`auto`/`demand`/`capacity`). `basicFee()` computes
  two-part basic charge; storage demand-shaving only reduces it under demand
  basis. Returns capex breakdown, per-year cashflow, finance, env, and a `load`
  summary (annualKwh, peakKw, basic-fee basis/amounts, demandCut).
- `js/optimizer.js` — `Optimizer`: `optimizeCapacity` (grid search + local
  refine), `optimizeDispatch` (compares 3 storage strategies), and
  `sizeStorage(cfg)` — back-calculates recommended storage kWh/kW from the load
  curve (valley-charge / peak-discharge, one cycle/day). Used by the UI's
  "AI auto-size storage" mode.
- `js/forecast.js` — `Forecast`: reverse-estimate annual kWh / peak from
  bill or peak; predict PV generation.
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
