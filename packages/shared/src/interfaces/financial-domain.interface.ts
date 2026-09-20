import { Direction, SignalGrade, SignalState, Timeframe, TradeLifecycleState } from '../enums';
import { CurrencyCode, MarginMode, IInstrument, ITradeAccountingSnapshot } from './index';

// ---------------------------------------------------------------------------
// Common Value Types & Status Enums
// ---------------------------------------------------------------------------

export type ReservationStatus = 'RESERVED' | 'CONSUMED' | 'RELEASED' | 'EXPIRED' | 'CANCELLED';

export type SizingModelType = 'FIXED_LOTS' | 'RISK_PERCENT' | 'FIXED_NOTIONAL' | 'VOLATILITY_TARGET';

export interface QuantityValidationResult {
  isValid: boolean;
  normalizedQuantity: number;
  reason?: string;
  code?: 'BELOW_MIN_QUANTITY' | 'EXCEEDS_MAX_QUANTITY' | 'INVALID_STEP' | 'ZERO_OR_NEGATIVE' | 'VALID';
}

export interface PriceValidationResult {
  isValid: boolean;
  normalizedPrice: number;
  reason?: string;
  code?: 'BELOW_MIN_PRICE' | 'INVALID_TICK' | 'ZERO_OR_NEGATIVE' | 'VALID';
}

export interface NotionalValidationResult {
  isValid: boolean;
  notional: number;
  reason?: string;
  code?: 'BELOW_MIN_NOTIONAL' | 'VALID';
}

// ---------------------------------------------------------------------------
// 1. TradeDecision Domain
// ---------------------------------------------------------------------------

export interface PreTradeDecisionParams {
  bot: any;
  signal: any;
  portfolio?: any;
  liveQuote?: { price: number; timestamp: Date } | null;
  systemConfig?: any;
  portfolioError?: any;
  liveQuoteError?: any;
}

export interface PreTradeDecisionResult {
  decision: 'TAKE' | 'REJECT';
  decisionReasonCode: string;
  decisionReason: string;
  confidenceScore?: number;
  plannedLevels?: {
    optimalEntry: number;
    stopLoss: number;
    target1: number;
    target2?: number;
    target3?: number;
    riskRewardRatio: number;
    quantity: number;
    riskAmount: number;
    riskPercent: number;
  };
  signalSnapshotJson?: any;
  marketSnapshotJson?: any;
  riskSnapshotJson?: any;
}

export interface CommitDecisionParams {
  bot: any;
  signal: any;
  decisionResult: PreTradeDecisionResult;
  fingerprint: string;
  correlationId: string;
  accountId: string;
  executionInstrument?: string;
  signalSourceInstrument?: string;
  executionInstrumentType?: string;
  contractSymbol?: string;
  strike?: number;
  optionType?: string;
  expiry?: string;
  signalDirection?: Direction;
  orderSide?: string;
}

export interface CommittedDecisionRecord {
  tradeDecisionId: string;
  fingerprint: string;
  decision: 'TAKE' | 'REJECT';
  decisionReasonCode: string;
  decisionReason: string;
  lifecycleState: TradeLifecycleState;
  executionId?: string;
  isDuplicate?: boolean;
}

export interface ITradeDecisionDomainService {
  evaluatePreTradeDecision(params: PreTradeDecisionParams): PreTradeDecisionResult;
  commitDecision(params: CommitDecisionParams): Promise<CommittedDecisionRecord>;
  getDecisionById(id: string): Promise<any | null>;
  getDecisionByFingerprint(fingerprint: string): Promise<any | null>;
}

// ---------------------------------------------------------------------------
// 2. PositionSizing Domain
// ---------------------------------------------------------------------------

export interface SizingCalculationParams {
  sizingModel: SizingModelType;
  accountBalance: number;
  riskPercentage?: number;
  entryPrice: number;
  stopLoss: number;
  symbol: string;
  instrument?: IInstrument;
  lots?: number;
  fixedNotional?: number;
  leverage?: number;
  availableMargin?: number;
  timestamp?: number;
  fxRate?: number;
  quoteCurrency?: CurrencyCode;
  accountCurrency?: CurrencyCode;
}

export interface SizingCalculationResult {
  isValid: boolean;
  quantity: number;
  lotCount: number;
  notionalQuote: number;
  notionalAccount: number;
  riskAmountAccount: number;
  riskPerUnitAccount: number;
  requiredMarginAccount: number;
  rejectionReason?: string;
  code?: string;
}

export interface IPositionSizingDomainService {
  calculateSizing(params: SizingCalculationParams): SizingCalculationResult;
  floorToStep(value: number, step: number): number;
  normalizePriceToTick(price: number, tickSize: number): number;
  validateQuantity(quantity: number, minQuantity: number, stepSize: number, maxQuantity?: number): QuantityValidationResult;
  validatePrice(price: number, tickSize: number): PriceValidationResult;
  validateNotional(notional: number, minNotional?: number): NotionalValidationResult;
}

// ---------------------------------------------------------------------------
// 3. Risk Domain
// ---------------------------------------------------------------------------

export interface RiskCheckResult {
  allowed: boolean;
  reasonCode?: string;
  message?: string;
  currentValue?: number;
  limitValue?: number;
}

export interface RiskEvaluationParams {
  accountId: string;
  symbol: string;
  instrumentType: string;
  orderSide: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  stopLoss?: number;
  target1?: number;
  target2?: number;
  target3?: number;
  leverage?: number;
  requiredMargin: number;
  riskAmountAccount: number;
  riskTimezone?: string;
}

export interface IRiskDomainService {
  evaluateOrderRisk(params: RiskEvaluationParams): Promise<RiskCheckResult>;
  checkMaxOpenPositions(accountId: string, maxLimit: number): Promise<RiskCheckResult>;
  checkMaxTradesPerDay(accountId: string, maxLimit: number, timezone?: string): Promise<RiskCheckResult>;
  checkMaxConsecutiveLosses(accountId: string, maxLimit: number): Promise<RiskCheckResult>;
  checkMaxDailyLoss(accountId: string, maxDailyLossPercent: number, initialCapital: number, timezone?: string): Promise<RiskCheckResult>;
  checkPositionRisk(riskAmount: number, maxRiskAmount: number): RiskCheckResult;
  checkExposureLimit(projectedExposure: number, maxExposureAllowed: number): RiskCheckResult;
}

// ---------------------------------------------------------------------------
// 4. Margin Domain
// ---------------------------------------------------------------------------

export interface MarginCalculationParams {
  instrument: IInstrument;
  quantity: number;
  price: number;
  leverage?: number;
  marginMode?: MarginMode;
  fxRate?: number;
}

export interface MarginCalculationResult {
  notionalQuote: number;
  notionalAccount: number;
  initialMarginRequired: number;
  maintenanceMarginRequired: number;
  effectiveLeverage: number;
  marginMode: MarginMode;
  liquidationPrice?: number;
}

export interface IMarginDomainService {
  calculateMargin(params: MarginCalculationParams): MarginCalculationResult;
  validateMarginSufficiency(availableMargin: number, requiredMargin: number, charges?: number): { sufficient: boolean; deficit: number };
}

// ---------------------------------------------------------------------------
// 5. Reservation Domain
// ---------------------------------------------------------------------------

export interface CreateReservationParams {
  accountId: string;
  botId: string;
  tradeDecisionId: string;
  fingerprint: string;
  riskAmount: number;
  marginAmount: number;
  exposureAmount: number;
  currency: string;
  expiresInSeconds?: number;
}

export interface ReservationRecord {
  reservationId: string;
  accountId: string;
  botId: string;
  tradeDecisionId: string;
  fingerprint: string;
  riskAmount: number;
  marginAmount: number;
  exposureAmount: number;
  currency: string;
  status: ReservationStatus;
  createdAt: Date;
  expiresAt: Date;
}

export interface IReservationDomainService {
  reserveResources(params: CreateReservationParams): Promise<ReservationRecord>;
  consumeReservation(reservationId: string): Promise<void>;
  releaseReservation(reservationId: string, reason?: string): Promise<void>;
  getActiveReservationsForAccount(accountId: string): Promise<ReservationRecord[]>;
  releaseExpiredReservations(): Promise<number>;
}

// ---------------------------------------------------------------------------
// 6. Execution Domain
// ---------------------------------------------------------------------------

export interface ExecutionRecord {
  id: string;
  fingerprint: string;
  botId: string;
  symbol: string;
  contractSymbol?: string;
  timeframe: string;
  direction: Direction;
  state: string;
  correlationId: string;
  orderPositionId?: string;
  failureReason?: string;
  failureReasonCode?: string;
}

export interface IExecutionDomainService {
  createExecution(params: any): Promise<ExecutionRecord>;
  markStarted(executionId: string): Promise<void>;
  markExecuted(executionId: string, orderPositionId?: string): Promise<void>;
  markFailed(executionId: string, reasonCode: string, message: string, retryable: boolean): Promise<void>;
  markReconciliationRequired(executionId: string, message: string): Promise<void>;
  getExecutionById(executionId: string): Promise<ExecutionRecord | null>;
}

// ---------------------------------------------------------------------------
// 7. Order Domain
// ---------------------------------------------------------------------------

export interface CreateOrderDto {
  accountId: string;
  symbol: string;
  contractSymbol?: string;
  instrumentType?: string;
  executionInstrument?: string;
  executionInstrumentType?: string;
  strike?: number;
  optionType?: string;
  expiry?: string;
  direction: Direction;
  strategyDirection?: Direction;
  sourceBotId?: string;
  orderType?: string;
  requestedQuantity: number;
  price?: number;
  triggerPrice?: number;
  stopLoss?: number;
  target1?: number;
  target2?: number;
  target3?: number;
  leverage?: number;
  idempotencyKey: string;
  correlationId: string;
  tradeDecisionId?: string;
  executionId?: string;
  clientOrderId?: string;
  brokerOrderId?: string;
  brokerAccountId?: string;
}

export interface OrderRecord {
  id: string;
  accountId: string;
  symbol: string;
  contractSymbol: string;
  instrumentType: string;
  direction: Direction;
  orderType: string;
  requestedQuantity: number;
  filledQuantity: number;
  price?: number;
  status: string;
  idempotencyKey: string;
  correlationId: string;
  clientOrderId?: string;
  brokerOrderId?: string;
}

export interface IOrderDomainService {
  createOrder(dto: CreateOrderDto): Promise<OrderRecord>;
  updateOrderStatus(orderId: string, status: string, details?: any): Promise<OrderRecord>;
  getOrderById(orderId: string): Promise<OrderRecord | null>;
  getOrderByClientOrderId(clientOrderId: string): Promise<OrderRecord | null>;
  getOrderByBrokerOrderId(brokerOrderId: string): Promise<OrderRecord | null>;
  getOrdersByPositionId(positionId: string): Promise<OrderRecord[]>;
}

// ---------------------------------------------------------------------------
// 8. Fill Domain
// ---------------------------------------------------------------------------

export interface RecordFillDto {
  orderId: string;
  positionId?: string;
  executionRole?: 'ENTRY' | 'TP1_PARTIAL' | 'TP2_PARTIAL' | 'FINAL_EXIT';
  fillPrice: number;
  fillQuantity: number;
  fee?: number;
  feeBreakdownJson?: any;
  slippage?: number;
  executionPriceSource?: string;
  liquidityType?: string;
  sourceTimestamp: Date;
  fillTimestamp?: Date;
  correlationId: string;
  brokerFillId?: string;
}

export interface FillRecord {
  id: string;
  orderId: string;
  positionId?: string | null;
  executionRole?: string | null;
  fillPrice: number;
  fillQuantity: number;
  fee: number;
  slippage: number;
  executionPriceSource: string;
  fillTimestamp: Date;
  correlationId: string;
  brokerFillId?: string;
}

export interface IFillDomainService {
  recordFill(dto: RecordFillDto): Promise<FillRecord>;
  getFillsByOrderId(orderId: string): Promise<FillRecord[]>;
  getFillsByPositionId(positionId: string): Promise<FillRecord[]>;
  getEntryFillsForPosition(positionId: string): Promise<FillRecord[]>;
  getExitFillsForPosition(positionId: string): Promise<FillRecord[]>;
}

// ---------------------------------------------------------------------------
// 9. Position Domain
// ---------------------------------------------------------------------------

export interface PositionProjectionResult {
  positionId: string;
  initialQuantity: number;
  totalEntryQuantity: number;
  totalExitQuantity: number;
  currentProjectedQuantity: number;
  weightedEntryPrice: number;
  isFullyClosed: boolean;
  isInconsistent: boolean;
  inconsistencyDetails?: string;
}

export interface PositionRecord {
  id: string;
  accountId: string;
  symbol: string;
  contractSymbol: string;
  direction: Direction;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  stopLoss?: number | null;
  initialStopLoss?: number | null;
  target1?: number | null;
  status: string;
  correlationId: string;
}

export interface IPositionDomainService {
  createPosition(params: any): Promise<PositionRecord>;
  recalculatePositionFromFills(positionId: string): Promise<PositionProjectionResult>;
  updatePositionStatus(positionId: string, status: string, closedAt?: Date): Promise<PositionRecord>;
  getPositionById(positionId: string): Promise<PositionRecord | null>;
  getActivePositions(accountId: string): Promise<PositionRecord[]>;
}

// ---------------------------------------------------------------------------
// 10. TradeLifecycle Domain
// ---------------------------------------------------------------------------

export interface LifecycleTransitionRequest {
  tradeDecisionId: string;
  expectedState?: TradeLifecycleState | TradeLifecycleState[];
  newState: TradeLifecycleState;
  event: string;
  correlationId: string;
  metadata?: Record<string, any>;
}

export interface LifecycleTransitionResponse {
  success: boolean;
  tradeDecisionId: string;
  previousState: TradeLifecycleState;
  currentState: TradeLifecycleState;
  transitionTime: Date;
  error?: string;
}

export interface ITradeLifecycleDomainService {
  transition(request: LifecycleTransitionRequest): Promise<LifecycleTransitionResponse>;
  isValidTransition(fromState: TradeLifecycleState, toState: TradeLifecycleState): boolean;
  getAllowedNextStates(state: TradeLifecycleState): TradeLifecycleState[];
}

// ---------------------------------------------------------------------------
// 11. Accounting Domain
// ---------------------------------------------------------------------------

export interface RealizedPnLCalculationParams {
  direction: Direction | string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  contractSize?: number;
  fxRate?: number;
  entryFees?: number;
  exitFees?: number;
  funding?: number;
}

export interface RealizedPnLCalculationResult {
  grossPnLQuote: number;
  grossPnLAccount: number;
  totalCharges: number;
  netPnLAccount: number;
  realizedR?: number;
  cashDelta: number;
}

export interface AccountLedgerDelta {
  cashBalanceDelta: number;
  usedMarginDelta: number;
  realizedPnLDelta: number;
  chargesDelta: number;
}

export interface IAccountingDomainService {
  calculateRealizedPnL(params: RealizedPnLCalculationParams): RealizedPnLCalculationResult;
  calculateUnrealizedPnL(direction: Direction | string, entryPrice: number, currentPrice: number, quantity: number, contractSize?: number, fxRate?: number): number;
  applyAccountDelta(accountId: string, delta: AccountLedgerDelta): Promise<any>;
  assertFinancialInvariants(account: any): void;
}

// ---------------------------------------------------------------------------
// 12. Journal Domain
// ---------------------------------------------------------------------------

export interface CreateJournalPayload {
  accountId: string;
  positionId: string;
  symbol: string;
  contractSymbol: string;
  instrumentType: string;
  direction: Direction;
  strategyDirection?: Direction;
  orderSide?: string;
  sourceBotId?: string;
  executionId?: string;
  tradeDecisionId?: string;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  realizedPnL: number;
  realizedR?: number;
  fees: number;
  maxFavorableExcursion?: number;
  maxAdverseExcursion?: number;
  holdingDurationSeconds?: number;
  entryTime?: Date;
  exitTime?: Date;
  exitReason: string;
  chargesJson?: any;
  signalSnapshotJson?: any;
  featureSnapshotJson?: any;
  outcomeSnapshotJson?: any;
  outcomeClassification?: string;
  correlationId: string;
}

export interface IJournalDomainService {
  createJournalEntry(payload: CreateJournalPayload): Promise<any>;
  getJournalByPositionId(positionId: string): Promise<any | null>;
  isJournalFinalized(positionId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// 13. Reconciliation Domain
// ---------------------------------------------------------------------------

export interface PositionReconciliationResult {
  positionId: string;
  isConsistent: boolean;
  storedQuantity: number;
  projectedQuantityFromFills: number;
  storedStatus: string;
  hasJournal: boolean;
  orderCount: number;
  fillCount: number;
  anomalies: string[];
}

export interface AccountReconciliationResult {
  accountId: string;
  isConsistent: boolean;
  cashBalance: number;
  usedMargin: number;
  activePositionsMarginSum: number;
  marginDiscrepancy: number;
  anomalies: string[];
}

export interface IReconciliationDomainService {
  reconcilePosition(positionId: string): Promise<PositionReconciliationResult>;
  reconcileAccount(accountId: string): Promise<AccountReconciliationResult>;
  runStartupReconciliation(): Promise<{ reconciledPositions: number; anomaliesFound: number }>;
}
