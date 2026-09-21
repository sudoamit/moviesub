# Comprehensive Trading Engine P0/P1 Production Hardening Audit (Phase 0)

**Target Baseline Commit**: `881723cc4de2fa06865324383bba0c68969dc0db`  
**Repository**: `https://github.com/sudoamit/moviesub`  
**Date**: September 21, 2026  
**Auditor**: Antigravity Quantitative Systems Audit  
**Classification**: Financial-Critical / P0-P1 Architecture Audit  

---

## 1. Executive Summary

This document establishes the Phase 0 baseline audit for the **P0/P1 Production Hardening** of the quant trading engine. The platform orchestrates multi-asset execution across Indian Index Options, Equities, and Cryptocurrencies, spanning signal generation, strategy decision-making, capital reservation, risk management, execution slicing, position monitoring, and trade journaling.

The audit identifies severe financial correctness, concurrency safety, durable state, and auditability gaps:
1. **Rule 1 Violation (In-Memory Financial State)**: Core financial entities—most critically capital reservations (`ReservationService`), circuit breakers (`CircuitBreakerService`), and outbox dispatch queues (`OutboxService`)—rely on in-memory JavaScript `Map` collections. A process crash or restart completely erases active reservations, failure counters, and pending outbox events.
2. **Rule 3 Violation (Floating-Point Contamination)**: Crucial financial calculations (P&L settlement, fees, margin requirements, partial exit quantities, and currency conversions) silently convert database `Decimal` values into native JavaScript IEEE-754 `Number` primitives, applying `Math.*` and `.toFixed(2)`/`.toFixed(4)` operations rather than exact Decimal arithmetic.
3. **Missing First-Class `RECONCILIATION_REQUIRED` State**: Network drops or broker submission timeouts are shoehorned into `FAILED_RETRYABLE` or `FAILED_FINAL` with reason codes, allowing dangerous automated retries or stranded unhedged fills.
4. **Lifecycle State Machine Bypass**: Multiple services (`paper-trading.service.ts`, `paper-position-monitor.service.ts`, `algo-bots.service.ts`, `reservation.service.ts`) directly mutate `TradeDecision.lifecycleState` via direct database updates, bypassing `TradeLifecycleService` and lacking optimistic concurrency Compare-And-Swap (CAS) protections.
5. **Entity Identity Conflation**: The persistent schema and domain logic conflate execution, order, and position identities (e.g. `orderPositionId`, orders returning position objects), while `PaperOrder` and `PaperFill` completely lack persistent broker identity columns (`brokerOrderId`, `clientOrderId`, `brokerAccountId`, `brokerFillId`).
6. **Duplicate Implementations**: Transaction costs and fees are calculated by four competing, unsynchronized mechanisms (`ExecutionCostService`, `TransactionCostScheduleManager`, `PaperTradingService.calculateCharges()`, and `@quant/backtesting/FeeModel`).

---

## 2. In-Memory State & Source-of-Truth Violations (Rule 1)

Financial state must never depend on process memory or single Redis keys without database backing. The audit identified the following violations:

### 2.1 `ReservationService` (`apps/api/src/trading-domain/reservation.service.ts`)
- **Implementation**:
  ```ts
  private readonly activeReservations = new Map<string, ReservationRecord>();
  ```
- **Violation**: Financial capital reservations (margin encumbrance, notional exposure, and position risk budget) are stored in an in-memory `Map`.
- **Failure Mode**:
  - If the API node restarts during an active execution, all active reservations evaporate.
  - In a multi-replica or clustered deployment, Node A cannot see reservations created by Node B, enabling double-spending of capital and margin limit breaches.
  - Concurrency checks rely on `Array.from(this.activeReservations.values())` rather than atomic row-level database locking or transactional constraints.

### 2.2 `CircuitBreakerService` (`apps/api/src/trading-domain/circuit-breaker.service.ts`)
- **Implementation**:
  ```ts
  private readonly breakers = new Map<string, CircuitBreakerRecord>();
  private readonly failureCounters = new Map<string, { count: number; lastFailureAt: Date }>();
  ```
- **Violation**: Tripped circuit breakers and consecutive failure counters are held in memory.
- **Failure Mode**: A service restart automatically un-trips all `HALTED` or `CLOSE_ONLY` circuit breakers, resuming order submission to malfunctioning brokers or failing strategies without explicit manual clearing.

### 2.3 `OutboxService` (`apps/api/src/trading-domain/outbox.service.ts`)
- **Implementation**:
  ```ts
  private readonly eventsById = new Map<string, OutboxEvent>();
  private readonly idByDeduplicationKey = new Map<string, string>();
  ```
- **Violation**: Outbox events waiting for worker leasing and channel dispatch are stored in memory.
- **Failure Mode**: If an event is written outside a database transaction or the service terminates before dispatch, the event is permanently lost, violating transactional outbox guarantees.

### 2.4 `AlertIdempotencyService` (`apps/api/src/alerts/alert-idempotency.service.ts`)
- **Implementation**:
  ```ts
  private readonly memoryLedger = new Map<string, AlertDeliveryRecord>();
  ```
- **Violation**: Falls back to an in-memory ledger when Redis is disconnected or during standalone execution, allowing duplicate alert deliveries on restart.

---

## 3. Database Schema & Migration Requirements

The current PostgreSQL schema (`prisma/schema.prisma`) lacks critical models, columns, and relational constraints required for institutional trading:

### 3.1 Missing Model: `TradeReservation`
There is no database table for reservations. A new model must be introduced:
```prisma
enum ReservationStatus {
  RESERVED
  CONSUMED
  RELEASED
  EXPIRED
  CANCELLED
}

model TradeReservation {
  id              String            @id @default(uuid())
  accountId       String
  account         PaperAccount      @relation(fields: [accountId], references: [id], onDelete: Cascade)
  botId           String?
  tradeDecisionId String?           @unique
  tradeDecision   TradeDecision?    @relation(fields: [tradeDecisionId], references: [id], onDelete: SetNull)
  executionId     String?           @unique
  execution       AlgoBotExecution? @relation(fields: [executionId], references: [id], onDelete: SetNull)
  fingerprint     String            @unique
  status          ReservationStatus @default(RESERVED)
  riskAmount      Decimal           @db.Decimal(18, 2)
  riskCurrency    String            @default("INR")
  marginAmount    Decimal           @db.Decimal(18, 2)
  marginCurrency  String            @default("INR")
  exposureAmount  Decimal           @db.Decimal(18, 2)
  exposureCurrency String           @default("INR")
  reservedQuantity Decimal          @db.Decimal(18, 4)
  symbol          String
  contractSymbol  String?
  expiresAt       DateTime
  consumedAt      DateTime?
  releasedAt      DateTime?
  cancelledAt     DateTime?
  releaseReason   String?
  version         Int               @default(1)
  correlationId   String
  createdAt       DateTime          @default(now())
  updatedAt       DateTime          @updatedAt

  @@index([accountId, status, expiresAt])
  @@index([fingerprint])
  @@index([correlationId])
  @@map("trade_reservations")
}
```

### 3.2 `PaperOrder` Deficiencies
`PaperOrder` currently lacks broker routing and timing fields:
- **Missing Columns**:
  - `clientOrderId String @unique`
  - `brokerOrderId String?`
  - `brokerAccountId String?`
  - `acknowledgedAt DateTime?`
  - `lastFillAt DateTime?`
  - `cancelRequestedAt DateTime?`
- **Current Workaround**:
  - Code in `order.service.ts` line 237 and `reconciliation.service.ts` line 570 searches `correlationId` or `idempotencyKey` as a substitute for `brokerOrderId`.
- **Required Constraint**:
  - `@@unique([brokerAccountId, brokerOrderId])` (where `brokerOrderId != null`).

### 3.3 `PaperFill` Deficiencies
`PaperFill` lacks external fill identity and idempotency constraints:
- **Missing Columns**:
  - `brokerAccountId String?`
  - `brokerOrderId String?`
  - `brokerFillId String?`
  - `feeCurrency String @default("INR")`
- **Missing Constraints**:
  - `@@unique([brokerAccountId, brokerFillId])` to prevent duplicate broker fill processing.

### 3.4 Missing `RECONCILIATION_REQUIRED` State
- `enum AlgoBotExecutionState` in `prisma/schema.prisma` lines 1157-1164:
  - Current: `RESERVED`, `EXECUTING`, `EXECUTED`, `FAILED_RETRYABLE`, `FAILED_FINAL`, `CANCELLED`.
  - Required: Add `RECONCILIATION_REQUIRED`.
- `enum TradeLifecycleState`:
  - Required: Add `RECONCILIATION_REQUIRED`.
- `enum OrderState`:
  - Required: Add `RECONCILIATION_REQUIRED`.

---

## 4. Lifecycle Transitions & State Machine Invariants

### 4.1 Direct Lifecycle Mutation Bypass
`TradeLifecycleService` was designed as the authoritative FSM, but five distinct files bypass it by executing direct database updates:
1. `apps/api/src/paper-trading/paper-trading.service.ts`:
   - Line 1463: `data: { ...(isBotManaged ? {} : { lifecycleState: TradeLifecycleState.POSITION_OPENED }) }`
   - Line 2241: `data: { lifecycleState: TradeLifecycleState.TRADE_CLOSED }`
2. `apps/api/src/paper-trading/paper-position-monitor.service.ts`:
   - Line 726: `data: { lifecycleState: stageMetadata.currentLifecycleState }`
3. `apps/api/src/trading-domain/reservation.service.ts`:
   - Line 83: `data: { lifecycleState: 'RESERVATION_FAILED' as any }`
   - Line 118: `lifecycleState: 'RESERVATION_CREATED' as any`
4. `apps/api/src/algo-bots/trade-decision.service.ts`:
   - Lines 1219, 1348, 1411, 1503, 1937 directly assign `lifecycleState`.
5. `apps/api/src/algo-bots/algo-bots.service.ts`:
   - Lines 1558, 1591, 1610, 1645 directly assign `lifecycleState: TradeLifecycleState.TRADE_REJECTED`.

### 4.2 Lack of Optimistic Concurrency (CAS) in Transitions
In `apps/api/src/trading-domain/trade-lifecycle.service.ts` line 321:
```ts
await this.prisma.tradeDecision.update({
  where: { id: tradeDecisionId },
  data: updateData,
});
```
This is an unconditioned write. If two threads read state `ORDER_SUBMITTED` concurrently, both pass transition validation, and both write to the database. The transition MUST use conditional updating:
```ts
const result = await tx.tradeDecision.updateMany({
  where: {
    id: tradeDecisionId,
    lifecycleState: { in: allowedExpectedStates },
  },
  data: {
    ...updateData,
    updatedAt: new Date(),
  },
});
if (result.count !== 1) {
  throw new LifecycleConflictException(...);
}
```

### 4.3 Missing Transition Audit Logging
`TradeLifecycleService` currently emits a console log (`this.logger.log`) but fails to write an immutable `AuditEvent` record inside the transaction. Every lifecycle transition must persist an `AuditEvent` with `previousState`, `newState`, `event`, `actor`, `correlationId`, and `metadata`.

---

## 5. Entity Identity Conflation

The codebase contains frequent conflations between distinct trading entities:

### 5.1 `orderPositionId` Conflation
- In `AlgoBotExecution`:
  - Line 1229: `orderPositionId String?`
- In `TradeDecision`:
  - Line 1332: `orderPositionId String?`
- In `ExecutionService.markExecuted`:
  - Accepts `orderPositionId?: string` and assigns it to `execution.orderPositionId`.
- **Flaw**: An order is a submission intent; a position is an inventory state resulting from one or more fills. Conflating them prevents:
  - Multi-order executions (e.g. iceberg child orders).
  - Accurate position aggregation across multiple scale-in orders.

### 5.2 Decoupled Relational Hierarchy
The canonical schema must enforce strictly:
```text
TradeDecision (1)
      ↓
AlgoBotExecution (1)
      ↓
TradeReservation (1)
      ↓
PaperOrder (1..N)
      ↓
PaperFill (1..N)
      ↓
PaperPosition (1) [Referencing all contributing entry/exit fills]
      ↓
PaperTrade (1) [Canonical Closed Journal Record]
```

---

## 6. Financial Calculations & Number/Decimal Precision Audit (Rule 3)

Rule 3 mandates that all authoritative financial calculations use Decimal arithmetic. The audit revealed rampant usage of JavaScript IEEE-754 floating-point operations:

| Location | Expression | Defect Description |
| :--- | :--- | :--- |
| `accounting.service.ts:163` | `Number((grossPnLQuote * effectiveFxRate).toFixed(2))` | Binary floating-point multiplication with arbitrary string rounding |
| `accounting.service.ts:170` | `Number((grossPnLAccount - totalCharges - unpricedSlippageAccountCost).toFixed(2))` | Compound float subtraction subject to representation drift |
| `accounting.service.ts:198` | `Number((netPnLAccount / effectiveInitialRisk).toFixed(2))` | R-multiple division loses precision before ledger persistence |
| `paper-trading.service.ts:1213` | `finalFillPrice * req.quantity * contractSize` | Turnover calculated in raw JS numbers |
| `paper-trading.service.ts:1223` | `Number((turnoverAccount / effLeverage).toFixed(2))` | Margin calculation subject to float truncation |
| `paper-position-monitor.service.ts:488` | `Number((originalQuantity * ratio).toFixed(4))` | TP1/TP2 scale-out quantity calculation truncates precision |
| `reservation.service.ts:76` | `Number(account.cashBalance) - totalCommittedMargin` | Available cash comparison done in raw floats |
| `reservation.service.ts:179` | `Number((res.marginAmount - consumedMargin).toFixed(2))` | Remaining reservation arithmetic done in floats |

### Remediation Pattern
Replace all authoritative arithmetic with `@prisma/client/runtime/library` or `decimal.js` methods:
```ts
// Incorrect (Current):
const grossPnLAccount = Number((grossPnLQuote * effectiveFxRate).toFixed(2));

// Correct (Required):
const grossPnLAccount = grossPnLQuoteDecimal.mul(effectiveFxRateDecimal).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
```

---

## 7. Fills as Position Source of Truth (Phase 8)

### Current Problem
In `PaperTradingService` and `PaperPositionMonitorService`, position state and quantity are mutated independently of the fill ledger:
- When a partial exit executes, `pos.quantity` is updated via `updateMany` using a calculated float:
  ```ts
  quantity: new Decimal(remainingQty)
  ```
- The fill record (`PaperFill`) is created as a side-effect, but the position quantity is NOT derived from the fill ledger.
- If a partial fill succeeds while the position update fails (or vice versa), the database enters a corrupt, unreconciled state.

### Required Architecture
1. **Fills as Authoritative Ledger**: Every quantity change on a position must correspond to an immutable `PaperFill` record.
2. **Reconciliation Invariant**:
   $$\text{position.quantity} \equiv \sum_{\text{role}=\text{ENTRY}} \text{fill.quantity} - \sum_{\text{role} \in \{\text{TP1}, \text{TP2}, \text{EXIT}\}} \text{fill.quantity}$$
3. **Projection Pattern**: `PositionService.recalculatePositionFromFills(positionId)` must be the authoritative source for updating `PaperPosition.quantity`, `usedMargin`, and `entryPrice`.

---

## 8. Partial Exit Sizing Safety & Step Normalization (Phase 9)

### Current Vulnerabilities
In `apps/api/src/paper-trading/paper-position-monitor.service.ts`:
```ts
const partialQty = Number((originalQuantity * ratio).toFixed(4));
const remainingQty = Number((currentQuantity - partialQty).toFixed(4));
```
- **Flaws**:
  - `ratio` is hardcoded as `0.3` or `0.5` without instrument lot size or step size awareness.
  - Hardcoded `.toFixed(4)` assumes 4 decimal places, which is invalid for instruments with integer lots (e.g. NIFTY lot size 65, RELIANCE step size 1) or crypto with 8 decimal places.
  - Floating-point calculations can round upward (e.g. `0.30000000000000004`), causing partial scale-outs to exceed allowed allocations or leave unfillable dust.

### Required Invariant
- **Strict Downward Step-Flooring**:
  $$Q_{\text{partial}} = \text{floor}\left(\frac{Q_{\text{initial}} \times \text{ratio}}{\text{stepSize}}\right) \times \text{stepSize}$$
- **Minimum Quantity Check**: If $Q_{\text{partial}} < \text{minQuantity}$, the engine must NEVER round up to $\text{minQuantity}$. It must either skip the partial exit or close the full position based on explicit strategy configuration.

---

## 9. Duplicate Implementations Matrix

The codebase contains multiple competing implementations of core trading logic:

| Functionality | Implementation A | Implementation B | Implementation C | Implementation D | Canonical Target |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Transaction Fees** | `ExecutionCostService` | `TransactionCostScheduleManager` | `PaperTradingService.calculateCharges()` | `FeeModel` (`@quant/backtesting`) | **`ExecutionCostService`** |
| **Slippage Modeling** | `ExecutionCostService` | `ExecutionPriceResolver` | `SlippageModel` (`@quant/backtesting`) | `PaperTradingService` | **`ExecutionCostService`** |
| **P&L Settlement** | `AccountingService` | `TradeAccountingEngine` (`@quant/risk-engine`) | `PaperTradingService.closePosition()` | `MetricsCalculator` (`@quant/backtesting`) | **`AccountingService` + `TradeAccountingEngine`** |
| **Pre-Trade Decision** | `TradeDecisionService` (API) | `DomainTradeDecisionService` (`trading-domain`) | `AlgoBotsService` | — | **`TradeDecisionService`** |
| **Position Sizing** | `PositionSizingService` (`trading-domain`) | `PositionSizer` (`@quant/risk-engine`) | Inline calculations in `TradeDecisionService` | — | **`PositionSizingService`** |

---

## 10. Concurrency Hazards & Failure Modes

1. **Double Reservation Hazard**: Because `ReservationService.activeReservations` is an in-memory `Map`, concurrent HTTP requests targeting the same account can both pass `availableCash < marginAmount` checks before either commits to memory.
2. **Orphan Reservation Leak**: If order placement fails due to a network drop or uncaught exception, reservations in memory can remain stranded until process restart.
3. **Competing State Monitors**: Both `PaperPositionMonitorService` in API and `PositionMonitorProcessor` in Worker listen to positions. Although the worker currently yields authority, there is no database-level distributed lock preventing dual processing if worker logic is re-enabled.
4. **Reconciliation Blindness**: `reconciliation.service.ts` attempts to resolve broker mismatches by directly overwriting positions rather than transitioning executions to `RECONCILIATION_REQUIRED` and freezing automated actions.

---

## 11. Phased Hardening Blueprint (Phases 1 — 11)

To achieve institutional robustness without breaking existing functionality, the implementation will proceed strictly across 11 systematic phases:

```text
Phase 1: Durable Trade Reservation (Prisma TradeReservation model + DB transaction)
Phase 2: Real RECONCILIATION_REQUIRED Execution State (FSM extension + fail-closed gating)
Phase 3: Authoritative Trade Lifecycle FSM (Remove all direct lifecycleState mutations)
Phase 4: Concurrency-Safe Lifecycle CAS (Optimistic locking + mandatory AuditEvent persistence)
Phase 5: Separation of Execution, Order, and Position Identity (Eliminate orderPositionId)
Phase 6: Broker Order Identity (brokerOrderId, clientOrderId, brokerAccountId in PaperOrder)
Phase 7: Broker Fill Identity & Idempotent Fill Ingestion (brokerFillId + unique constraints)
Phase 8: Fills as Position Source of Truth (recalculatePositionFromFills + derived quantity)
Phase 9: Partial Exit Safety & Step Size Normalization (Floor-to-step + zero upward rounding)
Phase 10: Decimal Financial Engine (Eliminate Number() and .toFixed() in authoritative paths)
Phase 11: Unified Execution Cost & Fee Schedule (Consolidate into single canonical authority)
```

---

## 12. Conclusion & Verification Readiness

The quant trading platform contains extensive analytical logic and domain modularity, but its financial durability is currently compromised by in-memory state, floating-point drift, and bypassed state machines.

By executing the 11-phase hardening roadmap, the engine will achieve complete auditability, ACID transaction safety, restart recovery, and institutional mathematical correctness.
