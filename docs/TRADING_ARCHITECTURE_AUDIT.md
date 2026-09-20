# Comprehensive Trading Architecture Audit (Phase 0)

**Target Baseline Commit**: `16b75bcf80213b883e0711d8e9c9ff5edf00cd24`  
**Repository**: `sudoamit/moviesub`  
**Date**: September 20, 2026  
**Auditor**: Antigravity Quantitative Systems Audit  

---

## Executive Summary

This document establishes the Phase 0 baseline audit of the trading and execution architecture. The platform currently supports automated signal generation (SMC/order blocks, liquidity sweeps, FVGs), strategy matching via Algo Bots, pre-trade decision gates, risk and sizing controls, paper trading execution with slippage and fee simulation, multi-leg position monitoring (TP1/TP2 partial scale-outs, breakeven trailing, TP3/SL exits), backtesting, and AI learning pipelines.

While substantial work has been done to establish model-based accounting, multi-asset handling (Spot and Indian Index Options), and concurrency guards, the system exhibits critical architectural gaps, duplicate implementations, floating-point vulnerabilities, missing database constraints, and lacks true broker-ready execution separation. 

This audit details the current implementation across all 9 required dimensions, identifies architectural flaws and duplicate calculations, and provides the authoritative target blueprint for Phases 1 through 43.

---

## 1. Current Architecture Overview

### 1.1 Repository & Workspace Topology
The repository is an npm workspace monorepo consisting of:
- **`apps/api`** (NestJS): Main API backend containing core modules:
  - `algo-bots`: Algo bot orchestration, bot definitions, strategy matching, pre-trade decision gates (`AlgoBotsService`, `TradeDecisionService`, `OptionContractResolver`, `OptionTradeLevelsResolver`).
  - `paper-trading`: Paper execution engine, position tracking, TP/SL monitoring (`PaperTradingService`, `PaperPositionMonitorService`, `PositionValuationService`).
  - `backtests`: Backtest execution controller and service (`BacktestsService`).
  - `market-data`: Real-time and historical market data streaming, quote caching, provider health, reconnection state machines (`RealMarketStreamerService`, `MarketDataService`, `LivePriceStreamerService`).
  - `options`: Indian options chain and strike valuation (`OptionsService`).
  - `alerts`: Alert dispatching for Telegram and Webhooks (`AlertsService`, dispatchers, rate-limiters).
  - `scanner`, `signals`, `candles`, `ai-learning`, `websocket`, `auth`.
- **`apps/worker`** (NestJS + BullMQ): Background worker processes:
  - `PositionMonitorProcessor`: Background job processor for active position monitoring.
  - `CandleProcessor`, `ScannerProcessor`, `LearningProcessor`.
- **`apps/web`** (Next.js): Trading dashboard and operational UI.
- **`packages/risk-engine`**:
  - `TradeAccountingEngine`: Margin, notional, P&L, and leg settlement calculations.
  - `PositionSizer`: Multi-asset position sizing based on risk budget, stop distance, and leverage.
  - `PortfolioRiskManager`: Portfolio-level exposure and drawdown checks.
  - `TradeLifecycleManager`: In-memory lifecycle transition validation.
  - `DrawdownGuard`, `ExecutionSafetyGate`.
- **`packages/trading-engine`**:
  - SMC analyzers, liquidity sweep engines, order block engines, FVG engines, signal scoring, ML expected value engine, `IndianOptionsExpiryEngine`.
- **`packages/backtesting`**:
  - `BacktestSimulator`, `ExecutionSimulator`, `FillModel`, `SlippageModel`, `SpreadModel`, `FeeModel`, `MetricsCalculator`.
- **`packages/shared`**:
  - Instrument registry (`AUTHORITATIVE_INSTRUMENTS`, `getAuthoritativeInstrument`), currency conversion (`PointInTimeCurrencyConverter`), market data validation, execution aggregation (`ExecutionAggregator`), shared interfaces, DTOs, and enums.

### 1.2 Data Storage & Persistence
- **PostgreSQL via Prisma (`prisma/schema.prisma`)**:
  - Authoritative persistence for instruments, candles, signals, strategies, backtests, accounts, orders, fills, positions, trades (journals), and system configs.
  - **Critical Finding**: The directory `prisma/migrations` does not exist. All schemas have been created or pushed directly (`prisma db push`), meaning database migrations are not version-controlled or deterministic.
- **Redis (ioredis)**:
  - Distributed caching for live ticks (`ticker:${SYMBOL}:live`), option contract LTPs (`option:ltp:${CONTRACT}`), and pub/sub notifications (`position-monitor:tick`).

---

## 2. Current Lifecycle Models & State Machines

### 2.1 Enumerated States Across the System

| Entity | Enum Name | Defined States |
| :--- | :--- | :--- |
| **Trade Lifecycle** | `TradeLifecycleState` | `SIGNAL_DETECTED`, `SIGNAL_VALIDATED`, `ELIGIBILITY_EVALUATED`, `RISK_APPROVED`, `PRE_TRADE_APPROVED`, `TRADE_TAKEN`, `TRADE_REJECTED`, `RESERVATION_CREATED`, `RESERVED`, `RESERVATION_FAILED`, `ORDER_SUBMITTED`, `ORDER_REJECTED`, `ORDER_PARTIALLY_FILLED`, `ORDER_FILLED`, `POSITION_OPENED`, `TP1_TRIGGERED`, `TP1_PARTIAL_FILLED`, `POSITION_PARTIALLY_CLOSED`, `SL_MOVED_TO_BREAKEVEN`, `TP2_TRIGGERED`, `TP2_PARTIAL_FILLED`, `TRAILING`, `TP3_TRIGGERED`, `EXIT_TRIGGERED`, `EXIT_PENDING`, `EXIT_SUBMITTED`, `EXIT_FILLED`, `POSITION_CLOSED`, `TRADE_CLOSED`, `TRADE_FAILED`, `TRADE_CANCELLED` |
| **Algo Bot Execution** | `AlgoBotExecutionState` | `RESERVED`, `EXECUTING`, `EXECUTED`, `FAILED_RETRYABLE`, `FAILED_FINAL`, `CANCELLED` |
| **Order State** | `OrderState` | `CREATED`, `RISK_CHECKED`, `REJECTED`, `SUBMITTED`, `ACKNOWLEDGED`, `PARTIALLY_FILLED`, `FILLED`, `CANCEL_REQUESTED`, `CANCELLED`, `FAILED` |
| **Position State** | `PositionState` | `PENDING`, `OPEN`, `PARTIALLY_CLOSED`, `CLOSING`, `EXIT_PENDING`, `CLOSED`, `INVALIDATED` |
| **Signal State** | `SignalState` | `PENDING`, `ACTIVE`, `TP1_HIT`, `TP2_HIT`, `TP3_HIT`, `SL_HIT`, `EXPIRED`, `INVALIDATED`, `CANCELLED` |

### 2.2 Lifecycle State Transitions Analysis
- Lifecycle transitions are scattered across `AlgoBotsService`, `TradeDecisionService`, `PaperTradingService`, and `PaperPositionMonitorService`.
- Direct Prisma updates occur on `tradeDecision`, `paperPosition`, and `algoBotExecution` without routing through an isolated, single-responsibility `TradeLifecycleService`.
- There is no `RECONCILIATION_REQUIRED` state in `TradeLifecycleState`, `AlgoBotExecutionState`, or `OrderState`. When an execution fails with an uncertain network outcome or timeout, the engine categorizes it as `FAILED_RETRYABLE` or `FAILED_FINAL`, creating the dangerous condition where an order may fill externally while locally marked failed.

---

## 3. Current Execution Flow

```text
[Signal Generated]
       ↓
[AlgoBotsService.evaluateSignalForBots]
       ↓ (Checks: Bot active, Paper trading enabled, Canonical timestamp valid)
[TradeDecisionService.evaluatePreTradeDecision]
       ↓ (Evaluates: Direction, Freshness, Score, Risk Limits)
   ┌───┴─────────────────────────────────────────┐
   ↓ (REJECT)                                    ↓ (TAKE)
[Commit TradeDecision]              [Commit TradeDecision (TRADE_TAKEN)]
(State: TRADE_REJECTED)                          ↓
                                    [Create AlgoBotExecution (RESERVED)]
                                                 ↓
                                    [Mark Execution EXECUTING]
                                    [Update Decision -> ORDER_SUBMITTED]
                                                 ↓
                                    [PaperTradingService.placeOrder]
                                                 ↓ (Atomic $transaction)
                                    - Create PaperOrder (FILLED)
                                    - Create PaperFill (ENTRY)
                                    - Create PaperPosition (OPEN)
                                    - Update PaperAccount (Cash & Margin)
                                                 ↓
                                    [Mark Execution EXECUTED]
                                    [Update Decision -> ORDER_FILLED]
                                    [Update Decision -> POSITION_OPENED]
```

### Critical Flaws in the Execution Flow
1. **Synchronous Immediate Fill Assumption**: `PaperTradingService.placeOrder` immediately simulates fill and creates a position in a single synchronous database transaction. There is no decoupled broker submission -> acknowledgment -> fill -> position projection pipeline.
2. **Order Returned as Position**: In `algo-bots.service.ts` line 1964, `placeOrder()` returns an `IPaperPosition` directly, which is assigned as `orderPositionId = orderResult.id`. Order identity and position identity are conceptually conflated.
3. **Missing Broker Identity**: `PaperOrder` lacks fields for `brokerOrderId`, `clientOrderId`, `brokerAccountId`, and `firstFillAt/lastFillAt`.

---

## 4. Current Accounting & Position Projection Flow

### 4.1 The Current Accounting Model ("Model-A")
The repository currently implements "Model-A" accounting in `PaperTradingService`:
1. **At Entry (`placeOrder`)**:
   - `cashBalance -= entryFees`
   - `realizedPnL -= entryFees`
   - `totalChargesPaid += entryFees`
   - `usedMargin += requiredMargin`
2. **At Partial Exit (`executePartialScaleOut` in `PaperPositionMonitorService`)**:
   - `cashBalance += partialGrossPnL - partialExitFees`
   - `realizedPnL += partialGrossPnL - partialExitFees`
   - `totalChargesPaid += partialExitFees`
   - `usedMargin -= releasedMargin`
3. **At Final Exit (`closePosition` in `PaperTradingService`)**:
   - `cashBalance += finalGrossPnL - finalExitFees`
   - `realizedPnL += finalGrossPnL - finalExitFees`
   - `totalChargesPaid += finalExitFees`
   - `usedMargin -= remainingUsedMargin`

### 4.2 Critical Flaws in Accounting
1. **Quantity Projection Not Derived from Fills**:
   - In `PaperPosition`, `quantity` is directly updated as a mutable scalar.
   - When a partial exit occurs, `pos.quantity` is subtracted using floating-point math: `(currentQuantity - partialQty).toFixed(4)`.
   - The position quantity is not authoritatively calculated as `sum(entry fills) - sum(exit fills)`.
   - If an exit fill fails to insert or is dropped, the position quantity becomes permanently out of sync with the fills ledger.
2. **Floating-Point Drift**:
   - Financial math in `TradeAccountingEngine` and `PaperTradingService` casts Prisma `Decimal` to JavaScript `Number`, performs arithmetic, and calls `.toFixed(2)` or `.toFixed(4)`.
   - This causes subtle rounding discrepancies, visible in baseline test assertions where `-0.07` is compared to `-0.07` with `toBeGreaterThan`.
3. **Ad-Hoc Fee Schedules**:
   - Fees are calculated via multiple parallel implementations: `PaperTradingService.calculateCharges()`, `TransactionCostScheduleManager`, and `FeeModel` in `@quant/backtesting`.

---

## 5. Current Risk & Margin Flow

### 5.1 Risk Calculation Locations
Risk checks are implemented across three separate layers:
1. **`TradeDecisionService.evaluatePreTradeDecision`**:
   - Checks `maxOpenPositions`, `maxTradesPerDay`, `maxConsecutiveLosses`, `maxPositionRiskPercent`, `maxDailyLossPercent`.
2. **`PaperTradingService.placeOrder`**:
   - Re-evaluates identical checks: `maxOpenPositions` (count from DB), `todayOrderCount >= config.maxTradesPerDay`, `recentTrades >= config.maxConsecutiveLosses`, `totalPositionRisk > maxAllowedRiskAmount`, `todayRealizedPnL < -maxDailyLossAllowed`, `req.leverage > maxLeverage`.
3. **`PositionSizer.calculatePosition`**:
   - Evaluates `riskAmountINR = accountBalance * (riskPercentage / 100)`, `riskPerUnitINR = stopDistance * contractSize * fxRate`, and `unitsByRisk = riskAmountINR / riskPerUnitINR`.

### 5.2 Critical Flaws in Risk & Margin
1. **Duplicated Risk Calculations**: The risk gating in `TradeDecisionService` and `PaperTradingService` duplicate logic and database queries. If a threshold is updated in one service, the other can reject or allow orders inconsistently.
2. **Exposure Conflated with Margin**: In `PaperTradingService.placeOrder` line 1255:
   `projectedTotalExposure = reconciledUsedMargin + requiredMargin;`
   `if (projectedTotalExposure > maxExposureAllowed)`
   Here, `reconciledUsedMargin` (leveraged margin) is directly compared against `maxExposureAllowed` (which is defined as a percentage of initial capital). Margin and notional exposure are fundamentally different financial metrics and must not be conflated.
3. **No Dynamic Margin Engine**: Margin is calculated assuming either `notional / leverage` or `100% notional` for spot. Derivatives-specific margin requirements (initial vs maintenance margin, mark price, liquidation distance) are not modeled as standalone services.

---

## 6. Current Instrument Model

### 6.1 Instrument Definitions
The platform currently has three distinct instrument representations:
1. **Prisma `Instrument` Model**:
   - `id`, `symbol`, `name`, `exchange`, `assetType`, `tickSize`, `lotSize`, `contractSize`, `currency`, `tradingHoursJson`, `isActive`.
2. **`AUTHORITATIVE_INSTRUMENTS` Registry (`packages/shared/src/instrument/instrument-registry.ts`)**:
   - Defines static in-memory descriptors for `NIFTY_SPOT`, `BANKNIFTY_SPOT`, `BTCUSDT_SPOT`, `NIFTY`, `BANKNIFTY`, `GOLD`, `SILVER`.
   - Enforces a spot-only universe (`SUPPORTED_SPOT_SYMBOLS = ['NIFTY_SPOT', 'BANKNIFTY_SPOT', 'BTCUSDT_SPOT']`).
   - Declares `FORBIDDEN_DERIVATIVE_INSTRUMENTS = ['NIFTY_FUT', 'BANKNIFTY_FUT', 'NIFTY_OPTION', 'BANKNIFTY_OPTION', 'BTCUSDT_PERP']`.
3. **`OptionContractResolver` (`apps/api/src/algo-bots/option-contract-resolver.ts`)**:
   - Dynamically synthesizes option contract definitions (e.g. `NIFTY 24500 CE`) with hardcoded lot sizes (`NIFTY: 65`, `BANKNIFTY: 15`) and step sizes (`NIFTY: 50`, `BANKNIFTY: 100`).

### 6.2 Critical Flaws in the Instrument Model
1. **Contradiction Between Spot-Only Registry and Options Execution**:
   - `instrument-registry.ts` marks `NIFTY_OPTION` as a forbidden derivative.
   - However, `AlgoBotsService` and `PaperTradingService` explicitly mandate options execution for NIFTY and BANKNIFTY bots (`OPTION_EXECUTION_REQUIRED`).
2. **Ambiguous BTC Identity**:
   - `BTCUSDT` is treated simultaneously as `BTCUSDT` and `BTCUSDT_SPOT`.
   - No explicit distinction exists for `BTCUSDT_PERP` vs `BTCUSDT_SPOT`.
3. **Missing Quantitative Instrument Constraints**:
   - Instruments do not specify `quantityStep`, `minNotional`, `maxQuantity`, or formal `marginModel` enums.
   - Sizing algorithms floor to `lotSize` rather than `quantityStep`.

---

## 7. Known Inconsistencies & Architectural Debt

1. **Missing Database Integrity Constraints**:
   - `PaperTrade.positionId` is not `@unique`. Two racing close workers can theoretically generate duplicate journal records.
   - Active position uniqueness per bot/symbol/account is not enforced by a database constraint.
   - Fills do not enforce unique broker fill identifiers.
2. **Worker Duplication & Shadow Code**:
   - `apps/worker/src/processors/position-monitor.processor.ts` (714 lines) contains hundreds of lines of dormant execution code (`executeFullClose`, `executePartialScaleOut`, `calculateCharges`).
   - The worker logs: `"Yielding lifecycle execution authority to PaperPositionMonitorService."` while retaining obsolete copies of the entire execution engine.
3. **No Atomic Resource Reservation**:
   - `AlgoBotExecution` is used merely as an execution lock on the trade fingerprint.
   - No actual cash, margin, or risk budget reservation is locked before order placement.
   - Two concurrent bots can reserve fingerprints simultaneously, pass pre-trade risk checks against the same available balance, and subsequently overcommit the account.
4. **No Transaction Outbox for Events & Alerts**:
   - `AlertsService.processSignalAlert` and WebSocket broadcasts publish directly and synchronously during the execution cycle.
   - If Redis or downstream network endpoints fail, the transaction either fails or the audit trail becomes inconsistent.
5. **No Reconciliation & Restart Recovery**:
   - The application lacks a startup reconciliation sweep. If the API server crashes while an order is in `ORDER_SUBMITTED` or `EXECUTING`, the execution remains permanently orphaned upon restart.
6. **Timezone Assumptions**:
   - Risk days (`startOfDay`) in `PaperTradingService` use UTC (`startOfDay.setUTCHours(0,0,0,0)`), while Indian market exchange hours operate on `Asia/Kolkata`.

---

## 8. Duplicate Calculations Matrix

| Calculation / Logic | Implementation 1 | Implementation 2 | Implementation 3 | Risk of Inconsistency |
| :--- | :--- | :--- | :--- | :--- |
| **Position Sizing** | `PositionSizer.calculatePosition` | `AlgoBotsService` (`bot.lots * lotSize`) | `PaperTradingService` (requested quantity checks) | Sizing rules bypass stop-risk models depending on entry point. |
| **Risk Gating** | `TradeDecisionService.evaluatePreTradeDecision` | `PaperTradingService.placeOrder` | `ExecutionSafetyGate` (`packages/risk-engine`) | Divergence in daily loss or position count limits between decision and execution. |
| **Fee / Charges Calculation** | `PaperTradingService.calculateCharges` | `PositionMonitorProcessor.calculateCharges` (worker) | `FeeModel` (`packages/backtesting`) | Realized P&L in backtests does not match paper or worker calculations. |
| **P&L Settlement** | `TradeAccountingEngine.settleExecutionLeg` | `PaperTradingService.closePosition` inline math | `BacktestSimulator.runSimulation` | Backtest P&L differs from paper execution P&L for identical trades. |
| **Position Monitoring & TP/SL** | `PaperPositionMonitorService` (API) | `PositionMonitorProcessor` (Worker) | `BacktestSimulator` execution orders | Worker and API code drift if worker is ever re-enabled. |
| **Option Contract Resolution** | `OptionContractResolver` | `OptionsService` | Inline regexes in `PaperTradingService` | Contract symbol formatting and lot size mismatches. |

---

## 9. Baseline Test Suite Status

Prior to any changes in this hardening program, the test suite was executed across all workspaces:

| Workspace | Total Suites | Passed | Failed | Status |
| :--- | :--- | :--- | :--- | :--- |
| `@quant/risk-engine` | 10 | 10 | 0 | **PASS** (154/154 tests) |
| `@quant/shared` | 7 | 7 | 0 | **PASS** (121/121 tests) |
| `@quant/backtesting` | 13 | 13 | 0 | **PASS** (165/165 tests) |
| `@quant/trading-engine` | 44 | 44 | 0 | **PASS** (306/306 tests) |
| `@quant/worker` | 1 | 1 | 0 | **PASS** (26/26 tests) |
| `src/algo-bots/__tests__` | 15 | 15 | 0 | **PASS** (127/127 tests) |
| `@quant/api` (All) | 42 | 40 | 2 | **2 Suites Failed** (28/354 tests failed) |
| `@quant/learning-engine` | — | — | — | **4 Tests Failed** (`self-improving-retraining-integrity.test.ts`) |

### Root Cause of Baseline `@quant/api` Failures:
1. `apps/api/src/paper-trading/__tests__/paper-trading-lifecycle.test.ts`:
   - Fails on `TEST 148-4`, `TEST 149-1`, `TEST 149-2`, `TEST 149-4`, `TEST 149-5` with `BadRequestException: Order Rejected [MAX_PORTFOLIO_RISK_EXCEEDED]: Position requires ₹920000.00 margin, which pushes portfolio exposure to ₹920000.00 (Limit: ₹200000.00)`.
   - The test attempts to place an order for 1 BTC at ~₹92,000 USD * 92 FX = ₹8.4M INR turnover with 1,000,000 INR account capital and a hardcoded 20% max total exposure limit (200,000 INR), resulting in an exposure rejection.
2. `apps/api/src/scanner/__tests__/scanner-live-pipeline.e2e.spec.ts`:
   - Fails because the scanned signal order is rejected by the same downstream exposure check.

---

## 10. Proposed Target Architecture

To achieve absolute financial consistency, concurrency safety, restart recovery, and auditability, the system will be refactored into the following unidirectional pipeline:

```text
                     ┌───────────────────┐
                     │   MARKET DATA     │
                     │  Freshness / Tick │
                     └─────────┬─────────┘
                               ↓
                     ┌───────────────────┐
                     │     STRATEGY      │
                     │  Signal Snapshot  │
                     └─────────┬─────────┘
                               ↓
                     ┌───────────────────┐
                     │  TRADE DECISION   │
                     │  Immutable Reason │
                     └─────────┬─────────┘
                               ↓
                  ┌─────────────────────────┐
                  │   POSITION SIZING       │
                  │ Quantity Step / Floor   │
                  └────────────┬────────────┘
                               ↓
                  ┌─────────────────────────┐
                  │      RISK ENGINE        │
                  │   Portfolio / Limits    │
                  └────────────┬────────────┘
                               ↓
                  ┌─────────────────────────┐
                  │      MARGIN ENGINE      │
                  │ Notional != Margin      │
                  └────────────┬────────────┘
                               ↓
                  ┌─────────────────────────┐
                  │   RESERVATION SERVICE   │
                  │ Concurrency-Safe Lock   │
                  └────────────┬────────────┘
                               ↓
                  ┌─────────────────────────┐
                  │    EXECUTION ENGINE     │
                  │ Paper / Live Adapters   │
                  └────────────┬────────────┘
                               ↓
                  ┌─────────────────────────┐
                  │         ORDERS          │
                  │   Client / Broker ID    │
                  └────────────┬────────────┘
                               ↓
                  ┌─────────────────────────┐
                  │  IMMUTABLE FILL LEDGER  │
                  │ Provenance / Slippage   │
                  └────────────┬────────────┘
                               ↓
                  ┌─────────────────────────┐
                  │   POSITION PROJECTION   │
                  │ Derived from Fills Only │
                  └────────────┬────────────┘
                               ↓
                     ┌───────────────────┐
                     │   EXIT / TP / SL  │
                     │ Concurrency Safe  │
                     └─────────┬─────────┘
                               ↓
                  ┌─────────────────────────┐
                  │    ACCOUNTING ENGINE    │
                  │    Decimal Precision    │
                  └────────────┬────────────┘
                               ↓
                  ┌─────────────────────────┐
                  │    CANONICAL JOURNAL    │
                  │    1:1 with Position    │
                  └─────────────────────────┘

           ┌─────────────────────────────────────────┐
           │          RECONCILIATION ENGINE          │
           │ Broker ↔ Orders ↔ Fills ↔ Positions    │
           │ Startup Recovery & Outbox Publisher     │
           └─────────────────────────────────────────┘
```

---

## 11. Phased Hardening Roadmap

The remaining phases will be implemented incrementally without deleting working features:

- **Phase 1: Financial Domain Model** — Create service contracts and clear domain boundaries.
- **Phase 2: Authoritative Instrument Master** — Centralize instrument specifications (`InstrumentDefinition`, tick sizes, lot sizes, step sizes).
- **Phase 3: Position Sizing Engine** — Authoritative `floorToStep`, strict rejection below minQuantity, decimal precision.
- **Phase 4: Currency / FX Engine** — Point-in-time FX snapshots for every trade, order, and journal.
- **Phase 5: Risk Engine** — Separation of notional exposure, margin, and stop risk; explicit daily risk timezone.
- **Phase 6: Margin Engine** — Dedicated margin models (Spot leverage=1, Isolated derivative leverage, option premium).
- **Phase 7: Atomic Reservation Service** — Concurrency-safe reservations of margin, risk budget, and position slots.
- **Phase 8: Trade Lifecycle FSM** — Authoritative state machine preventing direct database mutations; addition of `RECONCILIATION_REQUIRED`.
- **Phase 9–11: Order, Fill Ledger & Execution Engine** — Decoupled orders and fills; position projection derived strictly from fills (`recalculatePositionFromFills`).
- **Phase 12–13: TP/SL & Gap Engine** — Quantity-safe partial exits, protected SL/TP concurrency, explicit slippage/gap policies.
- **Phase 14–16: Accounting, Journal & Snapshots** — Decimal arithmetic, unique journal constraint per position, immutable snapshots.
- **Phase 17–20: Reconciliation, Recovery, Outbox & Alerts** — Restart safety, transactional outbox, deduplicated alerts.
- **Phase 21–24: Market Safety, Sessions, Kill Switches & Circuit Breakers** — Stale tick rejection, market hours calendar, CLOSE_ONLY mode.
- **Phase 25–43: Backtesting, Metrics, Database Hardening & Final Validation** — Shared accounting across backtest/paper/live, database constraints, adversarial concurrency tests, and final invariant suite.
