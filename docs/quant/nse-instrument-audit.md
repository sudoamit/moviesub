# NSE Instrument & Derivatives Architecture Audit Report

**Date**: September 2026  
**Auditor**: Senior Quantitative Developer & NSE Derivatives Specialist  
**Target Repository**: `sudoamit/moviesub` (`quant_2`)

---

## 1. Executive Summary

This audit evaluates the current implementation of NIFTY and BANKNIFTY across market data, signal generation, instrument specifications, position sizing, order execution, margin modeling, MTM accounting, transaction costs, and backtesting metrics.

The platform has robust core abstractions (SMC analyzer, event-driven backtesting execution engine, deterministic risk models), but treats Indian index derivatives (`NIFTY`, `BANKNIFTY`) using **crypto perpetual semantics**:
1. **No distinction between Spot Index and Tradable Derivatives**: A single symbol `'NIFTY'` or `'BANKNIFTY'` is used simultaneously as the underlying signal source and the execution instrument.
2. **Outdated and Static Lot Sizes**: BANKNIFTY is hardcoded to 15 (revised market lot is 30, and historically 20, 25, 15). NIFTY is hardcoded to 65 without historical versioning (`effectiveFrom`/`effectiveTo`).
3. **Crypto Perpetual Liquidation Applied to Exchange Futures**: NSE index futures use crypto-style `ISOLATED_LINEAR` liquidation formulas (`entry * (1 - IMR + MMR)`) rather than exchange-standard daily MTM settlement, margin calls, and cash-settled expiration.
4. **Incorrect Metrics Annualization**: CAGR in `MetricsCalculator` divides point count by 252 (`points.length / 252`), treating 15-minute intraday snapshots as calendar days. Sharpe and Sortino ratios apply `sqrt(252)` directly to intraday return series rather than a daily closing equity series.
5. **Static, Date-Unaware Transaction Costs**: STT is fixed at 0.0125% on sell side; stamp duty is omitted; GST and SEBI charges are static; the 2024/2026 STT rate revisions (0.02% for futures, 0.1% on options premium) cannot be represented.
6. **Synthetic Fallbacks & Expiry Distortions**: Options pricing falls back to Black-Scholes theoretical valuation in backtests; BANKNIFTY is hardcoded to Wednesday weekly expiries without calendar holiday adjustments or historical period tracking.

---

## 2. Complete Path Trace: Current vs. Expected

| Stage | Current Implementation | Discovered Defect | Proposed Architecture (Target) |
|---|---|---|---|
| **Market Data** | `RealLiveMarketDataProvider` maps `NIFTY` &rarr; `^NSEI`, `BANKNIFTY` &rarr; `^NSEBANK`. `MockMarketDataProvider` creates synthetic bars. | No provenance tracking; research backtests can consume synthetic mock data silently. | Explicit `DataProvenance` (`sourceType`: `MOCK` \| `RESEARCH` \| `HISTORICAL` \| `LIVE`). Research backtests fail closed on `MOCK`. |
| **Spot Price** | Consumes spot index `^NSEI` / `^NSEBANK`. | Spot price used directly as tradeable asset price. | Spot price feeds `NIFTY_SPOT` / `BANKNIFTY_SPOT` exclusively for SMC signal generation. |
| **SMC Signal** | `SignalGenerator.generateSignal` generates signal on `symbol: 'NIFTY'`. | Generates signal on ambiguous generic symbol. | Signal carries `signalSourceInstrument: 'NIFTY_SPOT'` and closed candle proof. |
| **Instrument Selection** | Order placed on same symbol `'NIFTY'`. | Cannot select between `NIFTY_FUT` and `NIFTY_OPTION`. | Decouple `signalSourceInstrument` from `executionInstrument`. Signal on spot &rarr; execution on contract-master resolved Future or Option. |
| **Position Sizing** | `PositionSizer.calculatePosition` loads static `AUTHORITATIVE_INSTRUMENTS['NIFTY']`. | Static lot size (e.g. BANKNIFTY=15); no historical effective date resolution. | Point-in-time `ContractSpecification` resolved via `ContractMaster.getContract(symbol, timestamp)`. |
| **Order Submission** | `execSim.submitOrder` with spot price. | Order price not validated against contract tick size rules; spot price entered as derivative price. | Validate order prices, limits, SL/TP against `getTickSize(instrument, price, timestamp)`. |
| **Fill Simulation** | `FillModel.simulateFill` matches on next bar. | Slippage and fill price not quantized to dynamic tick size. | Fill price quantized to dynamic tick size; fills generate explicit `IFill` with contract multiplier. |
| **Transaction Fees** | `FeeModel.calculateFees` applies hardcoded rates without timestamp. | Date-unaware; ignores 2024/2026 STT hikes; omits stamp duty; ignores contract multiplier. | `TransactionCostScheduleManager.getSchedule(exchange, instrument, timestamp)` with granular breakdown (Brokerage, STT, Exchange, SEBI, Stamp Duty, GST, IPFT). |
| **MTM Settlement** | **Completely absent**. No daily settlement. | Futures P&L treated as crypto unrealized difference until closed. | Daily `FuturesMtmEvent` ledger entry: `(settlementPrice - prevSettlementPrice) * qty * multiplier * direction`. |
| **Margin Modeling** | Fixed 20% IMR / 10% MMR / 5x leverage. | Crypto `ISOLATED_LINEAR` formula applied; labeled as real margin. | `MarginModel` interface with `NSE_MARGIN_APPROXIMATION` clearly labeled for research when SPAN is absent. |
| **Accounting & Equity** | `currentCash + realizedPnl + unrealizedPnl`. | Turnover calculated only as `entryPrice * qty`; misses exits and multiplier. | Turnover derived strictly from sum of all fills: `Σ(fillPrice * fillQty * multiplier)`. |
| **Performance Metrics** | `years = points.length / 252`, intraday returns * `sqrt(252)`. | 10,000 15-minute candles = 39.6 years; intraday Sharpe is mathematically invalid. | Elapsed calendar time from timestamps: `(t_end - t_start) / msPerYear`. Daily sampled equity curve for daily returns &rarr; annualize with $\sqrt{252}$ for equities. |

---

## 3. Detailed Breakdown of Discovered Bugs & Affected Files

### 3.1 Instrument Identity & Contract Master
- **Affected Files**:
  - `packages/shared/src/instrument/instrument-registry.ts`
  - `packages/shared/src/interfaces/index.ts`
  - `packages/shared/src/enums/index.ts`
- **Discovered Issues**:
  - `NIFTY` and `BANKNIFTY` are registered with `AssetType.INDEX`, but simultaneously configured with `marginMode: 'ISOLATED'`, `defaultLeverage: 5`, and `liquidationModel: 'ISOLATED_LINEAR'`.
  - Cash indices cannot be margined, leveraged, or liquidated. Tradable derivatives (`NIFTY_FUT`, `BANKNIFTY_FUT`, options) are missing from the registry.
  - No `ContractSpecification` abstraction with `effectiveFrom` and `effectiveTo` versioning.

### 3.2 Signal Source vs. Execution Instrument Separation
- **Affected Files**:
  - `packages/backtesting/src/backtest-simulator.ts`
  - `packages/backtesting/src/types.ts`
  - `apps/api/src/algo-bots/algo-bots.service.ts`
  - `apps/api/src/algo-bots/trade-decision.service.ts`
- **Discovered Issues**:
  - `BacktestSimulator` uses `symbol` for both `SignalGenerator.generateSignal` and `execSim.submitOrder`.
  - There is no parameter or pipeline support for `signalSourceInstrument` (e.g. `NIFTY_SPOT`) vs `executionInstrument` (e.g. `NIFTY_FUT` or option).

### 3.3 Dynamic Lot Size & Tick Size
- **Affected Files**:
  - `packages/shared/src/instrument/instrument-registry.ts`
  - `packages/risk-engine/src/position-sizer.ts`
  - `packages/backtesting/src/execution/fill-model.ts`
- **Discovered Issues**:
  - `BANKNIFTY` lot size hardcoded to 15 (NSE revised to 30; historical periods were 25, 20, 40, etc.).
  - `NIFTY` lot size hardcoded to 65 (historical periods were 50, 75, 25).
  - Tick size permanently fixed at 0.05 without dynamic price or contract resolution (`getTickSize(instrument, price, timestamp)`).
  - Orders and fills do not reject non-tick price increments.

### 3.4 Expiry Calendar & Holiday Awareness
- **Affected Files**:
  - `packages/trading-engine/src/indian-options-expiry.ts`
  - `packages/shared/src/market-data/venue-session-calendar.ts`
  - `packages/trading-engine/src/session-filter.ts`
- **Discovered Issues**:
  - `IndianOptionsExpiryEngine` hardcodes `BANKNIFTY = Wednesday`, ignoring that BANKNIFTY weekly was Thursday before Sept 2023, monthly contracts expired on last Thursday, and SEBI Nov 2024 regulations revised index weekly expiries.
  - Zero holiday awareness: if an expiry day falls on an exchange holiday (e.g. Diwali, Independence Day, Eid), NSE prepones expiry to the previous trading day. The current code outputs the holiday date.
  - No contract calendar to resolve valid historical contract series.

### 3.5 Futures MTM & Liquidation Model
- **Affected Files**:
  - `packages/risk-engine/src/trade-accounting-engine.ts`
  - `packages/risk-engine/src/trade-lifecycle-manager.ts`
  - `packages/backtesting/src/backtest-simulator.ts`
- **Discovered Issues**:
  - `TradeAccountingEngine.calculateLiquidationPrice` applies `entryPrice * (1 - initialMarginRate + MMR)` to `NIFTY` and `BANKNIFTY`.
  - NSE exchange futures do not experience automated price liquidation; they are subject to daily MTM cash credits/debits and broker margin calls.
  - No `FuturesMtmEvent` ledger or daily settlement price integration exists.

### 3.6 Date-Aware Transaction Costs & Taxes
- **Affected Files**:
  - `packages/backtesting/src/execution/fee-model.ts`
  - `apps/api/src/paper-trading/paper-trading.service.ts`
  - `apps/worker/src/processors/position-monitor.processor.ts`
- **Discovered Issues**:
  - `FeeModel.calculateFees` has no timestamp parameter.
  - STT is fixed at 0.0125% (sell side). The Indian Union Budget / NSE circular increased STT on futures to 0.02% (sell side) and options to 0.1% (sell side on premium) effective October 1, 2024.
  - Stamp duty (0.002% on futures buy, 0.003% on options buy) is completely missing.
  - Turnover does not include contract multiplier.

### 3.7 Options Realism vs. Black-Scholes Substitution
- **Affected Files**:
  - `apps/api/src/options/options.service.ts`
  - `packages/backtesting/src/backtest-simulator.ts`
- **Discovered Issues**:
  - `OptionsService` falls back to `BlackScholesModel.calculate` whenever live quotes are missing (`finalCallLtp = callLtp && callLtp > 0 ? callLtp : bsCall.price`).
  - Synthesizes open interest via quadratic formula `45000 - Math.abs(i) * 3200`.
  - For historical backtesting, theoretical Black-Scholes prices must never substitute for historical market quotes. Missing data must fail closed.

### 3.8 Timezone & Session Mechanics
- **Affected Files**:
  - `packages/trading-engine/src/session-filter.ts`
  - `packages/shared/src/market-data/venue-session-calendar.ts`
- **Discovered Issues**:
  - `SessionFilter` converts UTC to IST via modulo arithmetic `(utcTimeVal + 330) % 1440`, which ignores date wrapping across midnight UTC, leading to erroneous day-of-week determinations.
  - No centralized exchange calendar for trading holidays, Muhurat sessions, or half-days.

### 3.9 Backtest Performance Metrics Distortion
- **Affected Files**:
  - `packages/backtesting/src/metrics-calculator.ts`
- **Discovered Issues**:
  - `years = Math.max(0.08, points.length / 252)` calculates elapsed time as number of bars divided by 252. For 10,000 15m intraday bars, this computes 39.6 years instead of ~100 trading days.
  - `returns` samples bar-to-bar intraday returns and multiplies by `Math.sqrt(252)`. Intraday return volatility cannot be annualized with daily $\sqrt{252}$.
  - Turnover sums only `entryPrice * positionSize` across trades, ignoring exit fills, partial exits, and contract multiplier.

---

## 4. Proposed Architecture

### 4.1 Explicit Instrument Hierarchy
```text
[Underlying Spot]
  ├── NIFTY_SPOT (assetType: INDEX, currency: INR, tradable: false/signal_only)
  └── BANKNIFTY_SPOT (assetType: INDEX, currency: INR, tradable: false/signal_only)

[Exchange Futures]
  ├── NIFTY_FUT (underlying: NIFTY_SPOT, assetType: FUTURE, multiplier: 1, marginMode: NSE_DERIVATIVE)
  └── BANKNIFTY_FUT (underlying: BANKNIFTY_SPOT, assetType: FUTURE, multiplier: 1, marginMode: NSE_DERIVATIVE)

[Exchange Options]
  ├── NIFTY_OPTION (underlying: NIFTY_SPOT, assetType: OPTION, strike, expiry, CE/PE)
  └── BANKNIFTY_OPTION (underlying: BANKNIFTY_SPOT, assetType: OPTION, strike, expiry, CE/PE)
```

### 4.2 Centralized Versioned Contract Master (`ContractMaster`)
```ts
export interface IContractSpecification {
  instrumentId: string;
  symbol: string;
  underlyingSymbol?: string;
  exchange: 'NSE';
  assetType: 'INDEX' | 'FUTURE' | 'OPTION';
  effectiveFrom: Date;
  effectiveTo?: Date;
  lotSize: number;
  tickSize: number;
  contractMultiplier: number;
  currency: 'INR';
  strikeInterval?: number;
  tradingStartTime: string; // '09:15'
  tradingEndTime: string;   // '15:30'
  timezone: 'Asia/Kolkata';
}
```

### 4.3 Exchange Trading & Expiry Calendar (`NseTradingCalendar`)
- Implements official NSE trading calendar including national holidays, special/Muhurat sessions, and weekend definitions.
- Prepones derivative expiry to previous trading day when standard expiry falls on a holiday.
- Tracks historical expiry rule shifts (e.g. BANKNIFTY Thursday &rarr; Wednesday in Sep 2023 &rarr; SEBI rationalization in Nov 2024).

### 4.4 Date-Aware Transaction Cost Engine (`NseTransactionCostEngine`)
- Resolves fee schedules based on trade timestamp:
  - Pre-Oct 2024 vs Post-Oct 2024 vs 2026 STT schedules.
  - Futures: Brokerage (₹20/0.03%), STT (0.0125% &rarr; 0.02%), Exchange charges (0.0019%), SEBI (0.0001%), Stamp duty (0.002% on buy), GST (18% on brokerage+turnover+sebi).
  - Options: Brokerage (flat ₹20), STT (0.0625% &rarr; 0.1% on sell premium), Exchange charges (0.05%), Stamp duty (0.003% on buy), GST (18%).

### 4.5 Futures MTM Accounting Engine
- Emits `FuturesMtmEvent` on daily settlement.
- Adjusts cash ledger and margin requirements without double-counting final closed P&L.
- Disables `ISOLATED_LINEAR` liquidation for NSE derivatives; implements margin call tracking.

### 4.6 Fill-Based Metrics & Correct Annualization
- Elapsed years: `(endTime - startTime) / (365.25 * 86400 * 1000)`.
- Daily closing equity curve constructed from intraday equity snapshots for true daily returns.
- Sharpe and Sortino annualized from daily return series with documented $\sqrt{252}$ convention.
- Turnover: `Σ(fill.price * fill.quantity * contractMultiplier)`.

---

## 5. Backward Compatibility Strategy

- Maintain legacy aliases:
  `NIFTY` &rarr; mapped to `NIFTY_SPOT` for signal generation / market data.
  `BANKNIFTY` &rarr; mapped to `BANKNIFTY_SPOT`.
- Never map legacy spot symbols silently to futures execution.
- Require callers of futures/option execution to specify an explicit execution instrument (`executionInstrument`).
- Keep frontend APIs intact while exposing richer contract metadata.

---

## 6. Required Tests

1. **Instrument Identity Tests**:
   - `NIFTY_SPOT` and `BANKNIFTY_SPOT` are `INDEX`, non-leveraged, marginMode `NONE`/`SPOT`.
   - `NIFTY_FUT` and `BANKNIFTY_FUT` are `FUTURE`, currency `INR`, exchange `NSE`.
2. **Contract Master & Historical Lot Size Tests**:
   - BANKNIFTY resolves lot size 15, 25, or 30 depending on as-of timestamp.
   - NIFTY resolves lot size 50, 75, or 65 depending on as-of timestamp.
3. **Tick Size Quantization Tests**:
   - Order prices and fills reject non-tick increments.
4. **Expiry Calendar & Holiday Shift Tests**:
   - Expiry dates shifting to preceding Wednesday/Tuesday when Thursday/Wednesday is a holiday.
   - Historical rule boundary transitions.
5. **Futures MTM Ledger Tests**:
   - Multi-day position holding with daily MTM events and zero double-counting on close.
   - Elimination of crypto-style liquidation price.
6. **Date-Aware Fee Tests**:
   - STT calculation pre-Oct 2024 vs post-Oct 2024 vs 2026.
   - Stamp duty on BUY side, STT on SELL side for futures.
7. **Fill-Based Turnover Tests**:
   - Turnover accurately sums entry + exit + TP + SL fills times contract multiplier.
8. **Options Realism & Anti-Fabrication Tests**:
   - Research backtest fails when historical option quotes are missing; no Black-Scholes substitution.
9. **Backtest Metric Accuracy Tests**:
   - CAGR calculates true elapsed time across multi-day intraday backtests.
   - Daily returns series properly sampled for Sharpe and Sortino.
10. **Data Provenance Guard Tests**:
    - Research backtest throws `BACKTEST_DATA_PROVENANCE_INVALID` if fed `MockMarketDataProvider`.
