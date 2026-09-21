import { Direction, PositionSide, SignalGrade, SignalState, Timeframe, TradeLifecycleState } from '../enums';
import { CurrencyCode, MarginMode, IInstrument, ITradeAccountingSnapshot, ICandle } from './index';

// ---------------------------------------------------------------------------
// 0. Instrument Master Domain (Phase 2)
// ---------------------------------------------------------------------------

export type DecimalLike = number | string | { toString(): string; toNumber?(): number };

export type InstrumentType =
  | 'SPOT'
  | 'FUTURE'
  | 'PERPETUAL'
  | 'OPTION'
  | 'STOCK'
  | 'FOREX'
  | 'COMMODITY';

export type InstrumentMarginModel =
  | 'SPOT'
  | 'ISOLATED'
  | 'CROSS'
  | 'OPTION_PREMIUM'
  | 'CUSTOM';

export interface InstrumentDefinition {
  id: string;
  symbol: string;
  exchange: string;

  instrumentType: InstrumentType;

  underlyingSymbol?: string;

  quoteCurrency: string;
  baseCurrency?: string;

  contractSize: DecimalLike;
  lotSize?: DecimalLike;

  minQuantity: DecimalLike;
  maxQuantity?: DecimalLike;
  quantityStep: DecimalLike;

  tickSize: DecimalLike;
  minNotional?: DecimalLike;

  leverageAllowed: boolean;
  maxLeverage?: DecimalLike;

  marginModel: InstrumentMarginModel;

  tradingTimezone: string;

  expiry?: Date;
  strike?: DecimalLike;
  optionType?: 'CE' | 'PE';
}

export interface OptionContractIdentity {
  exchange: string;
  underlying: string;
  expiry: Date;
  strike: number;
  optionType: 'CE' | 'PE';
  contractSize: number;
  lotSize: number;
  tradingTimezone: string;
}

export interface FxRateSnapshot {
  sourceCurrency: string;
  targetCurrency: string;
  rate: number;
  rateTimestamp: number;
  rateSource: string;
  pair: string;
  snapshotHash: string;
  version?: string;
}

export interface ICurrencyConversionService {
  getRate(sourceCurrency: string, targetCurrency: string, timestamp?: number): FxRateSnapshot;
  convert(
    amount: number,
    sourceCurrency: string,
    targetCurrency: string,
    timestamp?: number,
  ): { convertedAmount: number; fxSnapshot: FxRateSnapshot };
  triangulateRate(
    sourceCurrency: string,
    intermediateCurrency: string,
    targetCurrency: string,
    timestamp?: number,
  ): FxRateSnapshot;
  verifySnapshot(snapshot: FxRateSnapshot): boolean;
}

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
  instrument?: IInstrument | InstrumentDefinition;
  lots?: number;
  fixedNotional?: number;
  targetVolatility?: number;
  annualizedVol?: number;
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

export interface TradeRiskCalculation {
  tradeRiskAmount: number;
  tradeRiskPercent: number;
  tradeNotional: number;
  marginRequired: number;
}

export interface PortfolioRiskSnapshot {
  openPositionRisk: number;
  openPositionCount: number;
  totalNotionalExposure: number;
  totalUsedMargin: number;
  dailyRealizedLoss: number;
  dailyRisk: number;
}

export interface ComprehensiveRiskEvaluation {
  allowed: boolean;
  reasonCode?: string;
  message?: string;
  tradeRisk?: TradeRiskCalculation;
  portfolioRisk?: PortfolioRiskSnapshot;
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
  contractSize?: number;
  leverage?: number;
  notional?: number;
  requiredMargin: number;
  riskAmountAccount: number;
  riskTimezone?: string;
  availableMargin?: number;
  treatBreakevenAsLoss?: boolean;
  fxRate?: number;
}

export interface IRiskDomainService {
  evaluateOrderRisk(params: RiskEvaluationParams): Promise<RiskCheckResult>;
  calculateTradeRisk(params: {
    entryPrice: number;
    stopLoss?: number;
    quantity: number;
    contractSize?: number;
    fxRate?: number;
    leverage?: number;
    marginMode?: string;
    accountEquity: number;
  }): TradeRiskCalculation;
  calculatePortfolioRisk(accountId: string, timezone?: string): Promise<PortfolioRiskSnapshot>;
  checkMaxOpenPositions(accountId: string, maxLimit: number): Promise<RiskCheckResult>;
  checkMaxTradesPerDay(accountId: string, maxLimit: number, timezone?: string): Promise<RiskCheckResult>;
  checkMaxConsecutiveLosses(accountId: string, maxLimit: number, treatBreakevenAsLoss?: boolean): Promise<RiskCheckResult>;
  checkMaxDailyLoss(accountId: string, maxDailyLossPercent: number, initialCapital: number, timezone?: string): Promise<RiskCheckResult>;
  checkPositionRisk(riskAmount: number, maxRiskAmount: number): RiskCheckResult;
  checkExposureLimit(projectedExposure: number, maxExposureAllowed: number): RiskCheckResult;
  checkMaxPortfolioRisk(projectedPortfolioRisk: number, maxPortfolioRiskAllowed: number): RiskCheckResult;
  checkMaxTotalExposure(projectedNotionalExposure: number, maxExposureAllowed: number): RiskCheckResult;
  checkMaxUsedMargin(projectedUsedMargin: number, maxMarginAllowed: number): RiskCheckResult;
}

// ---------------------------------------------------------------------------
// 4. Margin Domain
// ---------------------------------------------------------------------------

export interface MarginCalculationParams {
  instrument: IInstrument | InstrumentDefinition | any;
  quantity: number;
  price: number;
  direction?: Direction | PositionSide | string;
  leverage?: number;
  marginMode?: MarginMode;
  fxRate?: number;
  markPrice?: number;
  stopLoss?: number;
  fundingRate?: number;
  accountCashBalance?: number;
  currentUsedMargin?: number;
}

export interface MarginCalculationResult {
  notionalQuote: number;
  notionalAccount: number;
  notionalValue: number;
  initialMarginRequired: number;
  initialMargin: number;
  maintenanceMarginRequired: number;
  maintenanceMargin: number;
  effectiveLeverage: number;
  marginMode: MarginMode;
  liquidationPrice?: number;
  usedMargin?: number;
  availableMargin?: number;
  riskAmount?: number;
  markPrice?: number;
  marginRatio?: number;
  fundingRate?: number;
  fundingPayment?: number;
}

export interface LiquidationCalculationParams {
  entryPrice: number;
  leverage: number;
  maintenanceMarginRate: number;
  direction: Direction | PositionSide | string;
  maintenanceMarginAmount?: number;
}

export interface IMarginDomainService {
  calculateMargin(params: MarginCalculationParams): MarginCalculationResult;
  calculateLiquidationPrice(params: LiquidationCalculationParams): number | undefined;
  calculateMarginRatio(maintenanceMargin: number, marginEquity: number): number;
  calculateFundingPayment(notionalValue: number, fundingRate: number): number;
  validateMarginSufficiency(
    availableMargin: number,
    requiredMargin: number,
    charges?: number,
  ): { sufficient: boolean; deficit: number };
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
  notes?: string;
  metadata?: Record<string, any>;
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
  consumedMargin?: number;
  releasedMargin?: number;
  reason?: string;
}

export interface IReservationDomainService {
  reserveResources(params: CreateReservationParams): Promise<ReservationRecord>;
  consumeReservation(reservationId: string): Promise<ReservationRecord | void>;
  consumePartialReservation(reservationId: string, consumedMargin: number): Promise<ReservationRecord>;
  releaseReservation(reservationId: string, reason?: string, releasedMargin?: number): Promise<ReservationRecord | void>;
  getReservation(reservationId: string): Promise<ReservationRecord | null>;
  getReservationByFingerprint(fingerprint: string): Promise<ReservationRecord | null>;
  getActiveReservationsForAccount(accountId: string): Promise<ReservationRecord[]>;
  getTotalReservedMargin(accountId: string): Promise<number>;
  getTotalReservedExposure(accountId: string): Promise<number>;
  getTotalReservedRisk(accountId: string): Promise<number>;
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
  reservedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
}

export interface IExecutionDomainService {
  createExecution(params: any): Promise<ExecutionRecord>;
  markStarted(executionId: string): Promise<ExecutionRecord | void>;
  markExecuted(executionId: string, orderPositionId?: string): Promise<ExecutionRecord | void>;
  markFailed(executionId: string, reasonCode: string, message: string, retryable: boolean): Promise<ExecutionRecord | void>;
  markCancelled(executionId: string, reason?: string): Promise<ExecutionRecord | void>;
  markReconciliationRequired(executionId: string, message: string): Promise<ExecutionRecord | void>;
  resolveReconciliation(
    executionId: string,
    outcome: 'EXECUTED' | 'FAILED_FINAL',
    resolutionNotes: string,
    orderPositionId?: string,
  ): Promise<ExecutionRecord>;
  getExecutionById(executionId: string): Promise<ExecutionRecord | null>;
  getExecutionByFingerprint(fingerprint: string): Promise<ExecutionRecord | null>;
  getExecutionsByBotId(botId: string, limit?: number): Promise<ExecutionRecord[]>;
  getPendingReconciliations(): Promise<ExecutionRecord[]>;
  canTransition(fromState: string, toState: string): boolean;
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
  leverage?: number;
  strike?: number;
  optionType?: string;
  expiry?: string;
  submittedAt?: Date;
  firstFillAt?: Date;
  cancelledAt?: Date;
  createdAt?: Date;
}

export interface IOrderDomainService {
  createOrder(dto: CreateOrderDto): Promise<OrderRecord>;
  updateOrderStatus(orderId: string, status: string, details?: any): Promise<OrderRecord>;
  cancelOrder(orderId: string, reason?: string): Promise<OrderRecord>;
  getOrderById(orderId: string): Promise<OrderRecord | null>;
  getOrderByClientOrderId(clientOrderId: string): Promise<OrderRecord | null>;
  getOrderByBrokerOrderId(brokerOrderId: string): Promise<OrderRecord | null>;
  getOrdersByAccountId(accountId: string, status?: string): Promise<OrderRecord[]>;
  getActiveOrdersForAccount(accountId: string): Promise<OrderRecord[]>;
  getOrdersByPositionId(positionId: string): Promise<OrderRecord[]>;
  canTransition(fromState: string, toState: string): boolean;
}

// ---------------------------------------------------------------------------
// 8. Fill Domain
// ---------------------------------------------------------------------------

export interface RecordFillDto {
  orderId: string;
  positionId?: string;
  executionRole?: 'ENTRY' | 'TP1_PARTIAL' | 'TP2_PARTIAL' | 'FINAL_EXIT' | string;
  fillPrice: number;
  fillQuantity: number;
  expectedPrice?: number;
  fee?: number;
  totalFee?: number;
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
  expectedPrice?: number;
  fee: number;
  totalFee?: number;
  feeBreakdownJson?: any;
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
  calculateWeightedAveragePrice(fills: FillRecord[]): number;
  getTotalFillQuantity(fills: FillRecord[]): number;
  getTotalFillFees(fills: FillRecord[]): number;
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
  target2?: number | null;
  target3?: number | null;
  initialTarget1?: number | null;
  initialTarget2?: number | null;
  initialTarget3?: number | null;
  leverage?: number;
  usedMargin?: number;
  unrealizedPnL?: number;
  realizedPnL?: number;
  status: string;
  correlationId: string;
  openedAt?: Date;
  closedAt?: Date;
  createdAt?: Date;
}

export interface IPositionDomainService {
  createPosition(params: any): Promise<PositionRecord>;
  recalculatePositionFromFills(positionId: string): Promise<PositionProjectionResult>;
  syncPositionWithFills(positionId: string): Promise<PositionRecord>;
  updatePositionStatus(positionId: string, status: string, closedAt?: Date): Promise<PositionRecord>;
  closePosition(positionId: string, closedAt?: Date, reason?: string): Promise<PositionRecord>;
  updateStopLoss(positionId: string, stopLoss: number): Promise<PositionRecord>;
  updateTargets(
    positionId: string,
    targets: { target1?: number; target2?: number; target3?: number },
  ): Promise<PositionRecord>;
  getPositionById(positionId: string): Promise<PositionRecord | null>;
  getActivePositions(accountId: string): Promise<PositionRecord[]>;
  getPositionsByAccountId(accountId: string, status?: string): Promise<PositionRecord[]>;
  canTransition(fromState: string, toState: string): boolean;
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
  isTerminalState(state: TradeLifecycleState | string): boolean;
  getLifecycleState(tradeDecisionId: string): Promise<TradeLifecycleState | null>;
}

// ---------------------------------------------------------------------------
// 11. Accounting Domain
// ---------------------------------------------------------------------------

export interface Lot {
  id?: string;
  quantity: number;
  price: number;
  timestamp?: Date | number;
  fees?: number;
  fxRate?: number;
}

export interface MatchedLot {
  lotId?: string;
  matchedQuantity: number;
  entryPrice: number;
  exitPrice: number;
  grossPnLQuote: number;
  entryFeesAllocated: number;
}

export interface LotMatchingResult {
  matchedLots: MatchedLot[];
  remainingLots: Lot[];
  totalMatchedQuantity: number;
  weightedEntryPrice: number;
  exitPrice: number;
  unmatchedExitQuantity: number;
}

export type OutcomeClassification = 'WIN' | 'LOSS' | 'BREAKEVEN';

export interface RealizedPnLCalculationParams {
  direction: Direction | string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  contractSize?: number;
  fxRate?: number;
  fxSnapshot?: FxRateSnapshot;
  entryFees?: number;
  exitFees?: number;
  funding?: number;
  slippage?: number;
  slippageIncludedInPrices?: boolean;
  instrumentType?: InstrumentType | string;
  optionType?: 'CE' | 'PE' | string;
  initialRiskAccount?: number;
  initialStopLoss?: number;
}

export interface RealizedPnLCalculationResult {
  grossPnLQuote: number;
  grossPnLAccount: number;
  totalCharges: number;
  netPnLAccount: number;
  realizedR?: number;
  cashDelta: number;
  slippage?: number;
  fxSnapshot?: FxRateSnapshot;
  outcomeClassification: OutcomeClassification;
}

export interface PositionSettlementParams {
  accountId: string;
  positionId: string;
  role: 'ENTRY' | 'TP1_PARTIAL' | 'TP2_PARTIAL' | 'FINAL_EXIT' | 'STOP_LOSS' | 'MANUAL_EXIT' | string;
  direction: Direction | string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  releasedMargin: number;
  instrumentType?: InstrumentType | string;
  optionType?: 'CE' | 'PE' | string;
  contractSize?: number;
  fxRate?: number;
  fxSnapshot?: FxRateSnapshot;
  entryFees?: number;
  exitFees?: number;
  funding?: number;
  slippage?: number;
  slippageIncludedInPrices?: boolean;
  initialRiskAccount?: number;
  initialStopLoss?: number;
  applyToAccount?: boolean;
}

export interface PositionSettlementResult {
  pnlResult: RealizedPnLCalculationResult;
  ledgerDelta: AccountLedgerDelta;
  accountUpdated?: any;
}

export interface AccountLedgerDelta {
  cashBalanceDelta: number;
  usedMarginDelta: number;
  realizedPnLDelta: number;
  chargesDelta: number;
}

export interface IAccountingDomainService {
  matchLots(entryLots: Lot[], exitQuantity: number, exitPrice: number, method?: 'FIFO' | 'LIFO'): LotMatchingResult;
  calculateRealizedPnL(params: RealizedPnLCalculationParams): RealizedPnLCalculationResult;
  calculateUnrealizedPnL(direction: Direction | string, entryPrice: number, currentPrice: number, quantity: number, contractSize?: number, fxRate?: number): number;
  settlePositionLeg(params: PositionSettlementParams): Promise<PositionSettlementResult>;
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
  entryFillAggregationJson?: any;
  exitFillAggregationJson?: any;
  outcomeClassification?: string;
  correlationId: string;
}

export interface JournalQueryOptions {
  symbol?: string;
  outcomeClassification?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

export interface JournalStatsResult {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakevenTrades: number;
  winRate: number;
  totalPnlAccount: number;
  profitFactor: number;
  averageR: number;
}

export interface IJournalDomainService {
  createJournalEntry(payload: CreateJournalPayload): Promise<any>;
  getJournalById(tradeId: string): Promise<any | null>;
  getJournalByPositionId(positionId: string): Promise<any | null>;
  getJournalsByAccountId(accountId: string, options?: JournalQueryOptions): Promise<any[]>;
  getJournalStats(accountId: string): Promise<JournalStatsResult>;
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

export interface OrderReconciliationResult {
  orderId: string;
  isConsistent: boolean;
  requestedQuantity: number;
  storedFilledQuantity: number;
  actualFillQuantitySum: number;
  storedStatus: string;
  fillCount: number;
  anomalies: string[];
}

export interface FullAuditReport {
  accountId: string;
  healthScore: number;
  isHealthy: boolean;
  accountResult: AccountReconciliationResult;
  positionResults: PositionReconciliationResult[];
  orderResults: OrderReconciliationResult[];
  unresolvedExecutions: string[];
  anomaliesCount: number;
  remediationSuggestions: string[];
}

export interface RemediationResult {
  success: boolean;
  remediatedPositions: number;
  remediatedMarginDrift: boolean;
  remediatedItems: string[];
  errors: string[];
}

export interface JournalReconciliationResult {
  auditedPositions: number;
  missingJournalCount: number;
  reconstructedJournals: number;
  duplicateJournals: number;
  anomalies: string[];
}

export interface BrokerFillReport {
  fillId: string;
  price: number;
  quantity: number;
  fee?: number;
  timestamp?: Date | number;
}

export interface BrokerOrderReport {
  brokerOrderId: string;
  clientOrderId?: string;
  orderId?: string;
  symbol: string;
  status: 'SUBMITTED' | 'ACKNOWLEDGED' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';
  filledQuantity: number;
  averagePrice?: number;
  executedFills?: BrokerFillReport[];
  updatedAt?: Date | number;
}

export interface BrokerReconciliationResult {
  orderId?: string;
  brokerOrderId: string;
  actionTaken: 'UPDATED_LOCAL_STATE' | 'NO_OP' | 'CANCELLED_LOCAL' | 'REJECTED_LOCAL' | 'ERROR';
  orderStatus: string;
  fillsCreated: number;
  positionUpdated: boolean;
  message: string;
}

export interface IReconciliationDomainService {
  reconcilePosition(positionId: string): Promise<PositionReconciliationResult>;
  reconcileAccount(accountId: string): Promise<AccountReconciliationResult>;
  reconcileOrder(orderId: string): Promise<OrderReconciliationResult>;
  reconcileJournal(accountId?: string): Promise<JournalReconciliationResult>;
  reconcileWithBroker(report: BrokerOrderReport): Promise<BrokerReconciliationResult>;
  performFullAudit(accountId: string): Promise<FullAuditReport>;
  autoRemediateAccount(accountId: string): Promise<RemediationResult>;
  runStartupReconciliation(): Promise<{ reconciledPositions: number; anomaliesFound: number }>;
  runPeriodicReconciliation(): Promise<{ auditedAccounts: number; anomaliesFound: number; remediated: boolean }>;
  afterBrokerReconnect(brokerId?: string): Promise<{ inFlightOrdersChecked: number; reconciled: number }>;
  afterUncertainExecution(executionId: string, brokerReport?: BrokerOrderReport): Promise<BrokerReconciliationResult>;
  afterWorkerRecovery(workerId?: string): Promise<{ positionsChecked: number; recovered: number }>;
}

export type OutboxEventStatus = 'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED' | 'DEAD_LETTER';

export interface OutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, any>;
  deduplicationId: string;
  correlationId: string;
  status: OutboxEventStatus;
  retryCount: number;
  maxRetries: number;
  lockedBy?: string;
  lockedUntil?: Date;
  lastError?: string;
  scheduledFor: Date;
  processedAt?: Date;
  createdAt: Date;
}

export interface CreateOutboxEventParams {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, any>;
  deduplicationId?: string;
  correlationId?: string;
  maxRetries?: number;
  scheduledFor?: Date;
}

export interface OutboxBatchProcessResult {
  totalProcessed: number;
  succeeded: number;
  failed: number;
  deadLettered: number;
  details: { eventId: string; status: OutboxEventStatus; error?: string }[];
}

export interface IOutboxDomainService {
  createEvent(params: CreateOutboxEventParams, tx?: any): Promise<OutboxEvent>;
  createBatch(events: CreateOutboxEventParams[], tx?: any): Promise<OutboxEvent[]>;
  fetchAndLockPendingEvents(limit?: number, lockDurationMs?: number, workerId?: string): Promise<OutboxEvent[]>;
  markPublished(eventId: string, workerId?: string): Promise<OutboxEvent>;
  markFailed(eventId: string, error: string, retryable?: boolean, workerId?: string): Promise<OutboxEvent>;
  processOutbox(batchSize?: number, workerId?: string): Promise<OutboxBatchProcessResult>;
  registerHandler(eventType: string, handler: (event: OutboxEvent) => Promise<void>): void;
  getEventById(eventId: string): Promise<OutboxEvent | null>;
  getEventsByAggregate(aggregateType: string, aggregateId: string): Promise<OutboxEvent[]>;
  getPendingCount(): Promise<number>;
  getDeadLetterEvents(limit?: number): Promise<OutboxEvent[]>;
  purgeProcessedEvents(retentionDays?: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// 15. Alert Idempotency Domain
// ---------------------------------------------------------------------------

export type AlertDeliveryStatus = 'IN_FLIGHT' | 'DELIVERED' | 'FAILED' | 'SUPPRESSED_DUPLICATE';

export interface AlertDeliveryRecord {
  id: string;
  eventId: string;
  channel: string;
  target: string;
  status: AlertDeliveryStatus;
  claimedBy?: string;
  claimedUntil?: Date;
  deliveredAt?: Date;
  failedAt?: Date;
  lastError?: string;
  messageId?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}

export interface ClaimAlertResult {
  canDispatch: boolean;
  reason?: 'DUPLICATE_DELIVERED' | 'ALREADY_IN_FLIGHT' | 'RATE_LIMITED' | string;
  existingRecord?: AlertDeliveryRecord;
}

export interface TradeAlertPayload {
  eventId: string;
  eventType: 'POSITION_OPENED' | 'POSITION_CLOSED' | 'SL_UPDATED' | 'TP_REACHED' | 'ORDER_FILLED' | 'RISK_BREACH' | string;
  positionId?: string;
  orderId?: string;
  symbol: string;
  direction: Direction | string;
  quantity: number;
  price: number;
  realizedPnL?: number;
  reason?: string;
  timestamp: Date | string;
  metadata?: Record<string, any>;
}

export interface IAlertIdempotencyService {
  claimDispatch(
    eventId: string,
    channel: string,
    target: string,
    ttlSeconds?: number,
    workerId?: string,
  ): Promise<ClaimAlertResult>;
  recordDelivered(
    eventId: string,
    channel: string,
    target: string,
    messageId?: string,
    metadata?: any,
  ): Promise<AlertDeliveryRecord>;
  recordFailed(
    eventId: string,
    channel: string,
    target: string,
    error: string,
  ): Promise<AlertDeliveryRecord>;
  isDelivered(eventId: string, channel: string, target: string): Promise<boolean>;
  getDeliveryRecord(eventId: string, channel: string, target: string): Promise<AlertDeliveryRecord | null>;
  getDeliveriesForEvent(eventId: string): Promise<AlertDeliveryRecord[]>;
  clearRecord(eventId: string, channel: string, target: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// 16. Market Data Safety Domain
// ---------------------------------------------------------------------------

export type MarketDataSource = 'LIVE' | 'CACHE' | 'SIMULATION' | 'BACKTEST' | 'MANUAL';

export interface MarketQuote {
  symbol: string;
  instrumentId: string;
  price: number;
  bid: number;
  ask: number;
  marketEventTime: number; // Provider event timestamp (ms epoch)
  receivedAt: number;      // Server arrival timestamp (ms epoch)
  provider: string;        // e.g. 'BINANCE', 'NSE', 'YAHOO', 'SIMULATOR'
  source: MarketDataSource;
  sequence?: number;
  metadata?: Record<string, any>;
}

export type QuoteUsageContext = 'RISK' | 'EXECUTION' | 'UI' | 'ACCOUNTING' | 'BACKTEST';

export interface MarketQuoteValidationResult {
  isValid: boolean;
  isStale: boolean;
  isClockSkewed: boolean;
  ageMs: number;
  skewMs: number;
  quote?: MarketQuote;
  rejectionReason?: string;
  rejectionCode?:
    | 'STALE_QUOTE'
    | 'CLOCK_SKEW'
    | 'INVALID_PRICE'
    | 'CROSSED_BOOK'
    | 'UNAUTHORIZED_SOURCE'
    | 'MISSING_FIELDS';
  displayStatus?: 'FRESH' | 'STALE' | 'DEGRADED' | 'UNAVAILABLE';
  staleIndicatorText?: string;
}

export interface MarketDataSafetyConfig {
  maxStaleAgeMs?: number;        // Max quote age for risk/execution (default: 5000ms)
  maxClockSkewMs?: number;       // Max provider vs server clock skew (default: 5000ms)
  maxFutureSkewMs?: number;      // Max allowed future clock skew (default: 3000ms)
  allowedSourcesForExecution?: MarketDataSource[]; // Default: ['LIVE']
}

export interface IMarketDataSafetyDomainService {
  validateQuote(
    quote: any,
    context: QuoteUsageContext,
    config?: MarketDataSafetyConfig,
    serverTimeMs?: number,
  ): MarketQuoteValidationResult;
  assertSafeForRiskOrExecution(
    quote: any,
    config?: MarketDataSafetyConfig,
    serverTimeMs?: number,
  ): MarketQuote;
  formatForUI(
    quote: any,
    config?: MarketDataSafetyConfig,
    serverTimeMs?: number,
  ): MarketQuoteValidationResult;
  detectClockSkew(
    marketEventTime: number,
    receivedAt: number,
    maxClockSkewMs?: number,
    maxFutureSkewMs?: number,
  ): { isSkewed: boolean; skewMs: number; direction: 'AHEAD' | 'BEHIND' | 'IN_TOLERANCE' };
}

// ---------------------------------------------------------------------------
// 17. Market Hours & Session Calendar Domain
// ---------------------------------------------------------------------------

export type MarketSessionState =
  | 'OPEN'
  | 'PRE_OPEN'
  | 'CLOSING_AUCTION'
  | 'POST_CLOSE'
  | 'CLOSED'
  | 'WEEKEND'
  | 'HOLIDAY'
  | 'EXPIRED';

export interface SessionCheckResult {
  isOpen: boolean;
  sessionState: MarketSessionState;
  exchange: string;
  symbol?: string;
  timezone: string;
  localTime: string;
  isExpired?: boolean;
  expiryTime?: Date;
  nextOpenTime?: Date;
  nextCloseTime?: Date;
  reason?: string;
}

export interface MarketScheduleProfile {
  exchange: string;
  timezone: string;
  is24x7: boolean;
  regularTradingStart: string; // HH:MM e.g. "09:15"
  regularTradingEnd: string;   // HH:MM e.g. "15:30"
  preOpenStart?: string;       // HH:MM e.g. "09:00"
  preOpenEnd?: string;         // HH:MM e.g. "09:15"
  postCloseStart?: string;     // HH:MM e.g. "15:40"
  postCloseEnd?: string;       // HH:MM e.g. "16:00"
  weekendDays: number[];       // 0 = Sunday, 6 = Saturday
  holidays: string[];          // "YYYY-MM-DD" formatted dates
}

export interface IMarketSessionDomainService {
  getSessionStatus(
    symbolOrInstrument: string | InstrumentDefinition,
    referenceTime?: Date,
  ): SessionCheckResult;
  isMarketOpen(
    symbolOrInstrument: string | InstrumentDefinition,
    referenceTime?: Date,
  ): boolean;
  assertMarketOpen(
    symbolOrInstrument: string | InstrumentDefinition,
    referenceTime?: Date,
  ): void;
  isOptionExpired(
    expiry: Date | string,
    timezone?: string,
    referenceTime?: Date,
  ): boolean;
  getNextMarketOpen(
    symbolOrInstrument: string | InstrumentDefinition,
    referenceTime?: Date,
  ): Date;
  getNextMarketClose(
    symbolOrInstrument: string | InstrumentDefinition,
    referenceTime?: Date,
  ): Date;
  registerHoliday(exchange: string, dateStr: string): void;
  getHolidays(exchange: string): string[];
}

// ---------------------------------------------------------------------------
// 23. Circuit Breaker & Kill Switch Domain
// ---------------------------------------------------------------------------

export type CircuitBreakerScope =
  | 'GLOBAL'
  | 'ACCOUNT'
  | 'BOT'
  | 'INSTRUMENT'
  | 'STRATEGY';

export type CircuitBreakerMode =
  | 'NORMAL'
  | 'CLOSE_ONLY'
  | 'HALTED';

export type CircuitBreakerAction =
  | 'ENTRY'
  | 'EXIT';

export interface CircuitBreakerRecord {
  id: string;
  scope: CircuitBreakerScope;
  targetId: string; // 'GLOBAL' | accountId | botId | symbol | strategyId
  mode: CircuitBreakerMode;
  reason: string;
  trippedAt: Date;
  trippedBy: string; // 'SYSTEM' | 'ADMIN' | 'RISK_ENGINE' | 'MONITOR' | user email
  expiresAt?: Date;
  cooldownSeconds?: number;
  metadata?: Record<string, any>;
  consecutiveFailures?: number;
  lastFailureAt?: Date;
}

export interface TripBreakerParams {
  scope: CircuitBreakerScope;
  targetId?: string; // Optional for GLOBAL (defaults to 'GLOBAL')
  mode: 'CLOSE_ONLY' | 'HALTED';
  reason: string;
  trippedBy?: string;
  cooldownSeconds?: number;
  metadata?: Record<string, any>;
}

export interface ResetBreakerParams {
  scope: CircuitBreakerScope;
  targetId?: string;
  actor?: string;
  reason?: string;
}

export interface EvaluateExecutionParams {
  action: CircuitBreakerAction;
  accountId?: string;
  botId?: string;
  symbol?: string;
  strategyId?: string;
  isEmergencyExit?: boolean;
}

export interface BreakerEvaluationResult {
  allowed: boolean;
  mode: CircuitBreakerMode;
  effectiveScope?: CircuitBreakerScope;
  effectiveTargetId?: string;
  reasonCode?: string;
  message: string;
}

export interface ICircuitBreakerDomainService {
  tripCircuitBreaker(params: TripBreakerParams): Promise<CircuitBreakerRecord>;
  resetCircuitBreaker(scope: CircuitBreakerScope, targetId?: string, actor?: string, reason?: string): Promise<CircuitBreakerRecord>;
  getBreakerStatus(scope: CircuitBreakerScope, targetId?: string): Promise<CircuitBreakerRecord>;
  getActiveBreakers(): Promise<CircuitBreakerRecord[]>;
  evaluateExecutionAllowed(params: EvaluateExecutionParams): Promise<BreakerEvaluationResult>;
  assertExecutionAllowed(params: EvaluateExecutionParams): Promise<void>;
  recordFailure(scope: CircuitBreakerScope, targetId: string, errorDetails?: string, failureThreshold?: number): Promise<{ tripped: boolean; record?: CircuitBreakerRecord }>;
  recordSuccess(scope: CircuitBreakerScope, targetId: string): Promise<void>;
  syncWithSystemConfig(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 24. Realized Volatility & Dynamic Sizing Domain
// ---------------------------------------------------------------------------

export type VolatilityEstimatorType =
  | 'CLOSE_TO_CLOSE'
  | 'PARKINSON'
  | 'GARMAN_KLASS'
  | 'YANG_ZHANG'
  | 'ATR';

export type VolatilityRegime =
  | 'LOW_VOLATILITY'
  | 'NORMAL_VOLATILITY'
  | 'HIGH_VOLATILITY'
  | 'EXTREME_VOLATILITY';

export interface RealizedVolatilityResult {
  estimator: VolatilityEstimatorType;
  period: number;
  dailyVolatility: number;
  annualizedVolatility: number;
  variance: number;
  annualizationFactor: number;
  details?: Record<string, any>;
}

export interface ATRResult {
  atr: number;
  normalizedATR: number; // ATR / last close percentage (e.g. 1.25)
  period: number;
  trueRanges: number[];
  regime: VolatilityRegime;
  adaptiveStopLossMultiplier: number;
}

export interface VolatilityTargetSizingParams {
  accountBalance: number;
  targetVolatilityPercent: number; // e.g. 10.0 for 10%
  realizedVolatilityAnnualized: number; // e.g. 0.20 for 20%
  entryPrice: number;
  contractSize?: number;
  fxRate?: number;
  minScaleFactor?: number; // default 0.25 (4x deleverage floor)
  maxScaleFactor?: number; // default 2.5 (2.5x leverage ceiling)
  minQuantity?: number;
  stepSize?: number;
  maxQuantity?: number;
}

export interface VolatilityTargetSizingResult {
  targetQuantity: number;
  normalizedQuantity: number;
  rawVolatilityScaleFactor: number; // TargetVol / RealizedVol
  clampedScaleFactor: number;
  targetRiskBudgetAccount: number;
  targetExposureAccount: number;
  isClamped: boolean;
  isValid: boolean;
  reason?: string;
  code?: string;
}

export interface IVolatilityDomainService {
  calculateCloseToCloseVol(candles: ICandle[], annualizationFactor?: number): RealizedVolatilityResult;
  calculateParkinsonVol(candles: ICandle[], annualizationFactor?: number): RealizedVolatilityResult;
  calculateGarmanKlassVol(candles: ICandle[], annualizationFactor?: number): RealizedVolatilityResult;
  calculateYangZhangVol(candles: ICandle[], annualizationFactor?: number): RealizedVolatilityResult;
  calculateATR(candles: ICandle[], period?: number, baselineATR?: number): ATRResult;
  classifyRegime(currentVol: number, baselineVol: number): VolatilityRegime;
  calculateVolatilityTargetSize(params: VolatilityTargetSizingParams): VolatilityTargetSizingResult;
  getAdaptiveStopLoss(entryPrice: number, direction: Direction | string, atrResult: ATRResult, baseMultiplier?: number): number;
}

// ---------------------------------------------------------------------------
// 25. Strategy Signal Aggregation & Conflict Resolution Domain
// ---------------------------------------------------------------------------

export type ConflictResolutionMode =
  | 'NET_POSITIONING'
  | 'PRIORITY_ARBITRATION'
  | 'CANCEL_OUT'
  | 'HTF_ALIGNMENT_ONLY';

export interface StrategySignal {
  signalId: string;
  strategyId: string;
  strategyType: string;
  symbol: string;
  direction: Direction | 'BUY' | 'SELL';
  confidence: number; // 0.0 to 1.0
  weight?: number;
  priority?: number;
  timestamp: Date | string | number;
  halfLifeMs?: number;
  timeframe?: string;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  metadata?: Record<string, any>;
}

export interface ContributingSignalSummary {
  signalId: string;
  strategyType: string;
  direction: Direction | 'BUY' | 'SELL';
  rawConfidence: number;
  decayedConfidence: number;
  weight: number;
  priority: number;
  isExpired: boolean;
  ageSeconds: number;
}

export interface AggregationOptions {
  resolutionMode?: ConflictResolutionMode;
  referenceTime?: Date;
  netConvictionThreshold?: number;
  maxSignalAgeMs?: number;
  expirationConfidenceFloor?: number;
  htfBias?: Direction | 'BUY' | 'SELL';
}

export interface AggregatedSignalResult {
  symbol: string;
  action: 'BUY' | 'SELL' | 'NEUTRAL';
  netScore: number;
  compositeConfidence: number;
  resolutionMode: ConflictResolutionMode;
  conflictsDetected: boolean;
  conflictDetails?: string;
  contributingSignals: ContributingSignalSummary[];
  confluenceMultiplier: number;
  suggestedEntryPrice?: number;
  suggestedStopLoss?: number;
  suggestedTakeProfit?: number;
  reason: string;
}

export interface MultiTimeframeConfluenceParams {
  htfSignal: StrategySignal;
  ltfSignal: StrategySignal;
  alignmentBoost?: number;
  counterTrendPenalty?: number;
  strictAlignment?: boolean;
}

export interface MultiTimeframeConfluenceResult {
  isAligned: boolean;
  compositeDirection: 'BUY' | 'SELL' | 'NEUTRAL';
  confluenceMultiplier: number;
  finalConfidence: number;
  status: 'ALIGNED' | 'COUNTER_TREND_PENALIZED' | 'COUNTER_TREND_REJECTED';
  details: string;
}

export interface ISignalAggregationDomainService {
  applySignalDecay(signal: StrategySignal, referenceTime?: Date): number;
  isSignalExpired(signal: StrategySignal, referenceTime?: Date, maxAgeMs?: number, minConfidenceFloor?: number): boolean;
  aggregateSignals(signals: StrategySignal[], options?: AggregationOptions): AggregatedSignalResult;
  resolveDirectionalConflict(signals: StrategySignal[], mode: ConflictResolutionMode, options?: AggregationOptions): AggregatedSignalResult;
  calculateMultiTimeframeConfluence(params: MultiTimeframeConfluenceParams): MultiTimeframeConfluenceResult;
}

// ---------------------------------------------------------------------------
// 26. Slippage Modeling & Execution Cost Domain
// ---------------------------------------------------------------------------

export type MarketImpactModelType =
  | 'ALMGREN_CHRISS_SQUARE_ROOT'
  | 'LINEAR'
  | 'FIXED_BPS'
  | 'ZERO';

export type OrderExecutionUrgency =
  | 'PASSIVE'
  | 'NEUTRAL'
  | 'AGGRESSIVE';

export type AssetChargeCategory =
  | 'EQUITY_INTRADAY'
  | 'EQUITY_DELIVERY'
  | 'FUTURES'
  | 'OPTIONS'
  | 'CRYPTO_SPOT'
  | 'CRYPTO_PERP';

export interface MarketImpactParams {
  orderQuantity: number;
  averageDailyVolume: number;
  price: number;
  dailyVolatility?: number;
  modelType?: MarketImpactModelType;
  impactConstant?: number;
  linearGamma?: number;
}

export interface MarketImpactResult {
  modelType: MarketImpactModelType;
  participationRate: number;
  impactBps: number;
  impactPriceDelta: number;
  estimatedImpactCost: number;
}

export interface SlippageEstimateParams {
  symbol: string;
  direction: Direction | 'BUY' | 'SELL';
  orderQuantity: number;
  referencePrice: number;
  bid?: number;
  ask?: number;
  averageDailyVolume?: number;
  dailyVolatility?: number;
  impactModel?: MarketImpactModelType;
  urgency?: OrderExecutionUrgency;
  maxSlippageBps?: number;
}

export interface SlippageEstimateResult {
  referencePrice: number;
  expectedFillPrice: number;
  halfSpreadBps: number;
  marketImpactBps: number;
  totalExpectedSlippageBps: number;
  expectedSlippageAmount: number;
  exceedsBudget: boolean;
  maxAllowedSlippageBps: number;
  actionAllowed: boolean;
  reason?: string;
}

export interface ItemizedChargeParams {
  exchange: 'NSE' | 'BINANCE' | string;
  category: AssetChargeCategory;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  contractSize?: number;
  optionPremium?: number;
  isMaker?: boolean;
}

export interface ItemizedExecutionCost {
  brokerage: number;
  stt: number;
  exchangeTurnover: number;
  sebiCharges: number;
  stampDuty: number;
  gst: number;
  totalTaxesAndCharges: number;
}

export interface TotalCostParams {
  slippageParams: SlippageEstimateParams;
  chargeParams: ItemizedChargeParams;
}

export interface TotalExecutionCostResult {
  itemizedCharges: ItemizedExecutionCost;
  slippageEstimate: SlippageEstimateResult;
  totalExpectedCostAccount: number;
  costBpsOfNotional: number;
}

export interface ExecutionQualityReport {
  orderId: string;
  expectedSlippageBps: number;
  realizedSlippageBps: number;
  slippageDriftBps: number;
  qualityAssessment: 'SUPERIOR' | 'IN_LINE' | 'DEGRADED' | 'EXCESSIVE';
  details: string;
}

export interface IExecutionCostDomainService {
  calculateMarketImpact(params: MarketImpactParams): MarketImpactResult;
  estimateSlippage(params: SlippageEstimateParams): SlippageEstimateResult;
  assertSlippageWithinBudget(params: SlippageEstimateParams): void;
  calculateItemizedCharges(params: ItemizedChargeParams): ItemizedExecutionCost;
  calculateTotalExecutionCost(params: TotalCostParams): TotalExecutionCostResult;
  analyzeExecutionQuality(orderId: string, expectedSlippageBps: number, realizedSlippageBps: number): ExecutionQualityReport;
}

// ============================================================================
// SECTION 27: SMART ORDER ROUTING (SOR) & EXECUTION SLICING ALGORITHMS
// ============================================================================

export type VenueType = 'EXCHANGE' | 'BROKER' | 'DARK_POOL' | 'LIQUIDITY_POOL';

export type RoutingStrategy =
  | 'BEST_PRICE'
  | 'LOWEST_COST'
  | 'LOWEST_LATENCY'
  | 'PRO_RATA_DEPTH'
  | 'WATERFALL';

export type SlicingAlgorithmType = 'TWAP' | 'VWAP' | 'ICEBERG' | 'DIRECT';

export interface VenueQuote {
  venueId: string;
  venueName?: string;
  symbol: string;
  bidPrice: number;
  bidQuantity: number;
  askPrice: number;
  askQuantity: number;
  makerFeeBps: number;
  takerFeeBps: number;
  latencyMs: number;
  isHealthy: boolean;
  lastUpdated: number;
}

export type ChildSliceStatus = 'PENDING' | 'ROUTED' | 'FILLED' | 'CANCELLED' | 'FAILED';

export interface ChildSlice {
  sliceIndex: number;
  parentOrderId: string;
  sliceQuantity: number;
  targetVenueId?: string;
  scheduledDelayMs: number;
  status: ChildSliceStatus;
  targetPrice?: number;
  filledQuantity?: number;
  fillPrice?: number;
  executionRole?: string;
}

export interface ParentOrder {
  parentOrderId: string;
  symbol: string;
  direction: Direction | 'BUY' | 'SELL';
  totalQuantity: number;
  remainingQuantity: number;
  slicingAlgorithm: SlicingAlgorithmType;
  routingStrategy: RoutingStrategy;
  slices: ChildSlice[];
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'PAUSED' | 'FAILED';
  createdAt: number;
}

export interface SlicingPlanParams {
  parentOrderId: string;
  symbol: string;
  direction: Direction | 'BUY' | 'SELL';
  totalQuantity: number;
  slicingAlgorithm: SlicingAlgorithmType;
  durationSeconds?: number;
  numberOfSlices?: number;
  displayQuantity?: number;
  volumeProfile?: number[];
  minSliceQuantity?: number;
  randomizeJitterPercent?: number;
}

export interface SlicingPlanResult {
  parentOrderId: string;
  algorithm: SlicingAlgorithmType;
  totalQuantity: number;
  slices: ChildSlice[];
  estimatedDurationSeconds: number;
  isValid: boolean;
  error?: string;
}

export interface RouteOrderParams {
  parentOrderId: string;
  sliceIndex: number;
  symbol: string;
  direction: Direction | 'BUY' | 'SELL';
  quantity: number;
  routingStrategy: RoutingStrategy;
  availableVenues: VenueQuote[];
  maxAllowedLatencyMs?: number;
}

export interface VenueAllocation {
  venueId: string;
  allocatedQuantity: number;
  price: number;
  estimatedFeeBps: number;
}

export interface RouteOrderResult {
  parentOrderId: string;
  sliceIndex: number;
  selectedVenueId: string;
  routingStrategy: RoutingStrategy;
  estimatedPrice: number;
  estimatedCostBps: number;
  routedQuantity: number;
  allocations?: VenueAllocation[];
  reason: string;
}

export interface ISmartOrderRoutingDomainService {
  generateSlicingPlan(params: SlicingPlanParams): SlicingPlanResult;
  routeOrder(params: RouteOrderParams): RouteOrderResult;
  assertRoutingHealthy(venues: VenueQuote[], maxAllowedLatencyMs?: number): void;
  calculateVwapVolumeProfile(historicalBuckets: number[]): number[];
}

