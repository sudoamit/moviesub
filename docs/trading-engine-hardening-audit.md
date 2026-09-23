# Trading Engine Hardening Audit — P0/P1 Financial Integrity

## Baseline Target Commit
`215746a762d64a60f3e0b4204be5f4c4df47c02c`

## Audit Date
2026-09-21

---

## 1. Executive Summary & Current Architecture

The quantitative trading engine currently supports signal evaluation, risk sizing, trade decisions, order placement, simulated fills, position monitoring, and trade journaling. However, an in-depth codebase audit reveals critical vulnerabilities across financial state durability, concurrency safety, entity identity separation, lifecycle state-machine enforcement, and floating-point arithmetic.

### Current Architectural Hierarchy (As Discovered)
```text
Signal (Market Event / In-Memory / DB)
  ↓
AlgoBotsService / TradeDecisionService (in-memory lock Set + DB TradeDecision)
  ↓
ReservationService (Recently DB-backed TradeReservation, but lacks SELECT ... FOR UPDATE account-level locking)
  ↓
AlgoBotExecution (State machine lacks RECONCILIATION_REQUIRED; updated without CAS)
  ↓
PaperOrder (Created in PaperTradingService / OrderService; uses correlationId instead of brokerOrderId)
  ↓
PaperFill (Created in PaperTradingService / FillService / ReconciliationService; lacks brokerFillId unique constraint)
  ↓
PaperPosition (Mutated directly in PaperTradingService, PositionMonitor, PositionService, ReconciliationService; quantity not pure fill-ledger projection)
  ↓
AccountingService / PaperTradingService (Uses Number(), .toFixed(), duplicate fee schedules)
  ↓
PaperTrade (Optional, non-unique positionId; risk of duplicate trade journal records)
```

---

## 2. Discovered Violations by Audit Domain

### A. Direct Lifecycle & State Mutations (Bypassing FSM / CAS)
1. **`TradeDecision.lifecycleState`**:
   - `ReservationService` lines 131, 170: Directly calls `tx.tradeDecision.update({ data: { lifecycleState: 'RESERVATION_FAILED' / 'RESERVATION_CREATED' } })`.
   - `TradeDecisionService` lines 1411, 1458, 1503, 1571: Directly calls `tx.tradeDecision.update` and `tx.tradeDecision.create` with raw lifecycle states.
   - `PaperTradingService` lines 1463, 2241: Directly sets `lifecycleState: TradeLifecycleState.POSITION_OPENED` and `TRADE_CLOSED`.
   - `PaperPositionMonitorService` line 726: Directly mutates `lifecycleState`.
   - `ReconciliationService` line 708: Directly mutates `lifecycleState`.
   - **Violation**: None of these updates pass through `TradeLifecycleService.transition()`, and none use Optimistic Concurrency Control (CAS) `where: { id, lifecycleState: expectedState }`.

2. **`AlgoBotExecution.state`**:
   - `ExecutionService` lines 108, 135, 169, 195, 214, 265: Direct `prisma.algoBotExecution.update` without CAS.
   - `ReconciliationService` lines 690, 747, 775, 884: Direct updates without conditional concurrency checks.
   - Missing first-class enum value: `RECONCILIATION_REQUIRED` does not exist in `enum AlgoBotExecutionState`.

3. **`PaperOrder.status`**:
   - `OrderService` lines 188, 209: Direct updates without expected-status checks.
   - `FillService` line 94: Direct update on fill without validating prior status.
   - `PaperTradingService` lines 1313, 1838: Direct status writes.
   - `ReconciliationService` lines 656, 729, 768, 855: Direct status modifications.

4. **`PaperPosition.status` & `PaperPosition.quantity`**:
   - `PositionService` lines 241, 274, 300, 327, 356: Updates status and quantity directly without CAS.
   - `PaperTradingService` lines 1718, 1803, 2100, 2385: Direct quantity and status mutations.
   - `PaperPositionMonitorService` line 634: Direct partial fill / close quantity deduction.
   - `ReconciliationService` line 354: **Silent rewrite** — overwrites `paperPosition.quantity` and status with `projectedQty` without quarantine or explicit remediation incident logging!

5. **`PaperAccount.usedMargin` & `PaperAccount.cashBalance`**:
   - `PaperTradingService` lines 1429, 2214, 2397: Direct increments/decrements.
   - `PaperPositionMonitorService` line 699: Direct margin updates.
   - `ReconciliationService` line 318: **Silent rewrite** — directly mutates `usedMargin` on `PaperAccount` when drift is detected.

---

### B. In-Memory Financial State & Ephemeral Locks
1. **`CircuitBreakerService`**:
   - `private readonly breakers = new Map<string, CircuitBreakerRecord>();`
   - `private readonly failureCounters = new Map<string, { count: number; lastFailureAt: Date }>();`
   - **Impact**: All breaker trips, failure counts, and cooldowns are wiped on server restart or worker crash. In a multi-replica deployment, one replica tripping a breaker does not protect other replicas!
2. **`OutboxService`**:
   - `private readonly eventsById = new Map<string, OutboxEvent>();`
   - `private readonly idByDeduplicationKey = new Map<string, string>();`
   - **Impact**: Outbox events are not persisted to PostgreSQL. If the process terminates before publishing, business transactions commit but events are permanently lost. No transactional atomic commit with business entities.
3. **`AlertIdempotencyService`**:
   - `private readonly memoryLedger = new Map<string, AlertDeliveryRecord>();`
   - **Impact**: Duplicate alert deliveries across concurrent workers or restarts.
4. **`AlgoBotsService`**:
   - `private readonly inMemoryLocks = new Set<string>();`
   - **Impact**: Locks do not coordinate across cluster nodes or survive restarts.

---

### C. Identity Conflation (Correlation vs Broker Identities)
1. **`PaperOrder`**:
   - Missing `clientOrderId` (system $\to$ broker), `brokerOrderId` (broker assigned), and `brokerAccountId` (venue identity).
   - Currently uses `correlationId` as a proxy for external broker identity.
2. **`PaperFill`**:
   - Missing `brokerAccountId`, `brokerOrderId`, `brokerFillId`, and `feeCurrency`.
   - Missing unique constraint: `@@unique([brokerAccountId, brokerFillId])`.
   - Duplicate broker fill messages currently risk inserting duplicate fills and inflating positions.
3. **`AlgoBotExecution` & `TradeDecision`**:
   - Store `orderPositionId String?` which conflates order identity and position identity into a single ambiguous column.

---

### D. Floating-Point Drift & Financial Math
1. **`accounting.service.ts`**:
   - Extensive usage of `Number(...)`, `.toFixed(8)`, `.toFixed(4)`, `.toFixed(2)` for fees, cash delta, gross P&L, net P&L, realized R, and lot allocations.
2. **`smart-order-routing.service.ts`**:
   - Uses `Number(x.toFixed(precision))` for child slice quantities.
   - **Waterfall Algorithm Critical Bug (Line 450)**: When venue depth is insufficient (`unallocated > 0`), the remaining quantity is dumped directly into the first venue:
     ```ts
     allocations[0].allocatedQuantity = Number((allocations[0].allocatedQuantity + unallocated).toFixed(4));
     ```
     This fabricates liquidity and bypasses venue depth constraints!
3. **`position-sizing.service.ts` & `margin.service.ts`**:
   - Converts Decimals to `Number()` before multiplication/division and rounds with `Math.floor()` / `Math.min()`.

---

### E. Duplicate Execution Cost Engines
1. `ExecutionCostService` (`trading-domain/execution-cost.service.ts`):
   - Computes Almgren-Chriss market impact, spread, slippage, and itemized charges.
2. `PaperTradingService.calculateCharges()` (`paper-trading/paper-trading.service.ts` line 160):
   - Duplicates broker commissions, exchange turnover charges, GST, SEBI charges, stamp duty, and STT.
3. `SmartOrderRoutingService`:
   - Calculates its own effective prices and costs in-memory.
4. **Violation**: Multiple sources of truth for transaction fees, slippage, and execution costs.

---

### F. Reconciliation Behavior
1. `ReconciliationService` automatically rewrites `paperPosition.quantity` and `paperAccount.usedMargin` in place without creating a durable quarantine or incident record.
2. It lacks a first-class `RECONCILIATION_REQUIRED` execution state to halt automated trading on ambiguous orders/positions.

---

## 3. Affected Database Models & Proposed Schema Migrations

### Migration Plan 1: Reservation & Account Locking (`paper_accounts`, `trade_reservations`)
- Add `account.version Int @default(1)` for optimistic concurrency, or use PostgreSQL native `SELECT ... FOR UPDATE` row-level locks on `PaperAccount`.
- Enforce strict reservation state transitions: `RESERVED` $\to$ `CONSUMED`, `RELEASED`, `EXPIRED`, `CANCELLED`.

### Migration Plan 2: First-Class `RECONCILIATION_REQUIRED` State
```prisma
enum AlgoBotExecutionState {
  RESERVED
  EXECUTING
  RECONCILIATION_REQUIRED // NEW
  EXECUTED
  FAILED_RETRYABLE
  FAILED_FINAL
  CANCELLED
}
```

### Migration Plan 3: Order External Identities (`paper_orders`)
```prisma
model PaperOrder {
  // ... existing fields ...
  clientOrderId    String?   @unique
  brokerOrderId    String?
  brokerAccountId  String?
  version          Int       @default(1)

  @@index([brokerAccountId, brokerOrderId])
}
```

### Migration Plan 4: Fill External Identities & Immutability (`paper_fills`)
```prisma
model PaperFill {
  // ... existing fields ...
  brokerAccountId  String?
  brokerOrderId    String?
  brokerFillId     String?
  feeCurrency      String?   @default("INR")

  @@unique([brokerAccountId, brokerFillId])
  @@index([brokerOrderId])
}
```

### Migration Plan 5: Durable Outbox Table (`outbox_events`)
```prisma
enum OutboxStatus {
  PENDING
  PROCESSING
  PROCESSED
  FAILED
  DEAD_LETTER
}

model OutboxEvent {
  id              String       @id @default(uuid())
  aggregateType   String
  aggregateId     String
  eventType       String
  payloadJson     Json
  deduplicationId String       @unique
  status          OutboxStatus @default(PENDING)
  retryCount      Int          @default(0)
  maxRetries      Int          @default(5)
  scheduledFor    DateTime     @default(now())
  lockedBy        String?
  lockedUntil     DateTime?
  processedAt     DateTime?
  lastError       String?
  correlationId   String?
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt

  @@index([status, scheduledFor])
  @@index([lockedUntil])
  @@map("outbox_events")
}
```

### Migration Plan 6: Durable Circuit Breakers (`circuit_breakers`)
```prisma
enum CircuitBreakerScope {
  GLOBAL
  ACCOUNT
  BOT
  INSTRUMENT
  STRATEGY
  VENUE
}

enum CircuitBreakerMode {
  NORMAL
  CLOSE_ONLY
  HALTED
}

model CircuitBreaker {
  id            String              @id @default(uuid())
  scope         CircuitBreakerScope
  targetId      String
  mode          CircuitBreakerMode  @default(NORMAL)
  failureCount  Int                 @default(0)
  lastFailureAt DateTime?
  trippedAt     DateTime?
  expiresAt     DateTime?
  reason        String?
  version       Int                 @default(1)
  createdAt     DateTime            @default(now())
  updatedAt     DateTime            @updatedAt

  @@unique([scope, targetId])
  @@map("circuit_breakers")
}
```

### Migration Plan 7: Durable Alert Deliveries (`alert_deliveries`)
```prisma
model AlertDelivery {
  id          String   @id @default(uuid())
  eventId     String
  channel     String
  target      String
  deliveredAt DateTime @default(now())
  workerId    String?

  @@unique([eventId, channel, target])
  @@map("alert_deliveries")
}
```

### Migration Plan 8: Parent & Child SOR Orders (`parent_orders`, `child_orders`)
```prisma
model ParentOrder {
  id                String       @id @default(uuid())
  parentOrderId     String       @unique
  accountId         String
  symbol            String
  direction         Direction
  slicingAlgorithm  String
  routingStrategy   String
  totalQuantity     Decimal      @db.Decimal(18, 4)
  remainingQuantity Decimal      @db.Decimal(18, 4)
  status            String       @default("ACTIVE")
  childOrders       ChildOrder[]
  createdAt         DateTime     @default(now())
  updatedAt         DateTime     @updatedAt

  @@map("parent_orders")
}

model ChildOrder {
  id                String       @id @default(uuid())
  parentOrderId     String
  parentOrder       ParentOrder  @relation(fields: [parentOrderId], references: [parentOrderId], onDelete: Cascade)
  sliceIndex        Int
  venueId           String
  requestedQuantity Decimal      @db.Decimal(18, 4)
  routedQuantity    Decimal      @db.Decimal(18, 4)
  executedQuantity  Decimal      @default(0.0) @db.Decimal(18, 4)
  status            String       @default("PENDING")
  clientOrderId     String?      @unique
  brokerOrderId     String?
  scheduledAt       DateTime
  submittedAt       DateTime?
  completedAt       DateTime?

  @@index([parentOrderId, sliceIndex])
  @@map("child_orders")
}
```

### Migration Plan 9: Position Journal Uniqueness (`paper_trades`)
```prisma
model PaperTrade {
  // Enforce 1:1 relation with closed PaperPosition
  positionId  String  @unique
  position    PaperPosition @relation(fields: [positionId], references: [id], onDelete: Restrict)
}
```

---

## 4. Transaction Boundaries & Concurrency Risks

### Current Flawed Flow:
```text
Worker 1: Reads cash balance (₹100,000)
Worker 2: Reads cash balance (₹100,000)
Worker 1: Checks margin for ₹80,000 reservation -> OK
Worker 2: Checks margin for ₹80,000 reservation -> OK
Worker 1: Creates reservation (committed: ₹80,000)
Worker 2: Creates reservation (committed: ₹80,000) -> OVERCOMMITTED TO ₹160,000!
```

### Authoritative Hardened Transaction Boundary (Phase 1 Target):
```sql
BEGIN TRANSACTION;

-- 1. Acquire exclusive lock on Account row
SELECT * FROM paper_accounts WHERE id = :accountId FOR UPDATE;

-- 2. Load active positions margin
SELECT COALESCE(SUM("usedMargin"), 0) FROM paper_positions
WHERE "accountId" = :accountId AND status IN ('OPEN', 'PARTIALLY_CLOSED');

-- 3. Load active unexpired reservations margin
SELECT COALESCE(SUM("marginAmount"), 0) FROM trade_reservations
WHERE "accountId" = :accountId AND status = 'RESERVED' AND "expiresAt" > NOW();

-- 4. Calculate available capital using strict Decimal arithmetic
-- available = cashBalance - (activePositionMargin + activeReservationMargin)
-- IF available < requiredMargin THEN ROLLBACK & THROW InsufficientMarginException

-- 5. Insert TradeReservation record (status = RESERVED)

-- 6. Transition TradeDecision via TradeLifecycleService (CAS protected)

-- 7. Insert OutboxEvent in same transaction

COMMIT TRANSACTION;
```

---

## 5. Comprehensive Hardening Test Plan

| Phase | Test Suite Area | Key Scenarios Tested |
| :--- | :--- | :--- |
| **Phase 1** | `reservation-concurrency.spec.ts` | 2 concurrent workers attempting ₹80k reservation on ₹100k account; exactly 1 succeeds, 1 rejected with `INSUFFICIENT_MARGIN_RESERVATION`. Explicit state transitions (cannot consume twice, cannot release after consume). |
| **Phase 2** | `execution-reconciliation.spec.ts` | Broker timeout transitions `EXECUTING` $\to$ `RECONCILIATION_REQUIRED`. Auto-retry blocked. Resolution via `resolveExecutionAsExecuted()` and `resolveExecutionAsFailed()` requiring audit evidence. |
| **Phase 3-4** | `trade-lifecycle-cas.spec.ts` | CAS conditional update test: Worker A tries `SUBMITTED` $\to$ `FILLED` while Worker B tries `SUBMITTED` $\to$ `REJECTED`. Exactly one row count = 1; the other throws `LifecycleConflictException`. |
| **Phase 5** | `order-position-cas.spec.ts` | Concurrent status updates on `PaperOrder` and `PaperPosition`. Zero blind `prisma.update()` calls. |
| **Phase 6-7** | `broker-identity-dedup.spec.ts` | Deduplication on `(brokerAccountId, brokerFillId)`. Delivering identical broker fill twice results in idempotent no-op or duplicate rejection. Fills are strictly immutable. |
| **Phase 8-9** | `fill-ledger-projection.spec.ts` | Position quantity computed as `SUM(ENTRY fills) - SUM(EXIT fills)`. Partial exit quantity floored to `quantityStep`, zero upward rounding, dust policy validation. |
| **Phase 10** | `decimal-financial-math.spec.ts` | Zero `Number()`, `.toFixed()`, `Math.round()` in cash, margin, fees, and P&L calculations. Precision assertions up to 18 decimal places. |
| **Phase 11** | `canonical-execution-costs.spec.ts` | `ExecutionCostService` as sole authority. Removal of duplicate fee calculations in `PaperTradingService`. |
| **Phase 12-13** | `durable-outbox.spec.ts` | Outbox event committed atomically with financial mutation. Worker crash test with `FOR UPDATE SKIP LOCKED` lease expiry recovery. |
| **Phase 14** | `alert-idempotency.spec.ts` | Concurrent workers claiming same alert; DB unique constraint `(eventId, channel, target)` ensures exactly one delivery. |
| **Phase 15-16** | `durable-circuit-breaker.spec.ts` | Multi-instance breaker trips; restart recovery; hard execution gate blocking new orders when `HALTED` or `CLOSE_ONLY`. |
| **Phase 21** | `paper-trade-journal-unique.spec.ts`| Exactly one `PaperTrade` per closed position enforced by DB unique constraint. |
| **Phase 22** | `reconciliation-quarantine.spec.ts` | Discrepancy detection freezes position into `RECONCILIATION_REQUIRED` instead of silently updating quantity. Generates auditable remediation record. |
| **Phase 24-29** | `sor-hardening.spec.ts` | Slices persisted to DB (`ParentOrder`, `ChildOrder`). Waterfall depth truncation: depth 18 of requested 100 results in partial fill of 18 + unallocated 82, NOT dumped into first venue. Stale quote rejection. |
| **Phase 31-33** | `full-restart-recovery-invariants.spec.ts` | Full system crash injection with in-flight reservations and executions. Deterministic startup sweep. Complete invariants pass in real PostgreSQL. |

---

## 6. Phase 0 Conclusion & Readiness Gate

All 11 audit objectives have been thoroughly analyzed and documented:
1. Architectural hierarchy verified.
2. Direct mutations identified across 7 core state vectors.
3. In-memory `Map`/`Set` state documented in 4 services.
4. `correlationId` conflation cataloged.
5. All fill, order, and reconciliation paths mapped.
6. Waterfall liquidity fabrication bug pinpointed.
7. Database schema migration roadmap defined.

**Phase 0 is complete. No production code was modified during this audit phase.**
Awaiting explicit user approval before proceeding to **PHASE 1 (Transactionally Safe Trade Reservations with PostgreSQL Row-Level Account Locking)**.
