import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  ITradeLifecycleDomainService,
  LifecycleTransitionRequest,
  LifecycleTransitionResponse,
  TradeLifecycleState,
} from '@quant/shared';

@Injectable()
export class TradeLifecycleService implements ITradeLifecycleDomainService {
  private readonly logger = new Logger(TradeLifecycleService.name);

  // Authoritative DAG mapping of valid lifecycle transitions
  private readonly ALLOWED_TRANSITIONS: Record<TradeLifecycleState, TradeLifecycleState[]> = {
    [TradeLifecycleState.SIGNAL_DETECTED]: [
      TradeLifecycleState.SIGNAL_VALIDATED,
      TradeLifecycleState.TRADE_REJECTED,
      TradeLifecycleState.TRADE_CANCELLED,
    ],
    [TradeLifecycleState.SIGNAL_VALIDATED]: [
      TradeLifecycleState.ELIGIBILITY_EVALUATED,
      TradeLifecycleState.TRADE_REJECTED,
      TradeLifecycleState.TRADE_CANCELLED,
    ],
    [TradeLifecycleState.ELIGIBILITY_EVALUATED]: [
      TradeLifecycleState.RISK_APPROVED,
      TradeLifecycleState.TRADE_REJECTED,
      TradeLifecycleState.TRADE_CANCELLED,
    ],
    [TradeLifecycleState.RISK_APPROVED]: [
      TradeLifecycleState.PRE_TRADE_APPROVED,
      TradeLifecycleState.TRADE_REJECTED,
      TradeLifecycleState.TRADE_CANCELLED,
    ],
    [TradeLifecycleState.PRE_TRADE_APPROVED]: [
      TradeLifecycleState.TRADE_TAKEN,
      TradeLifecycleState.TRADE_REJECTED,
      TradeLifecycleState.TRADE_CANCELLED,
    ],
    [TradeLifecycleState.TRADE_TAKEN]: [
      TradeLifecycleState.RESERVATION_CREATED,
      TradeLifecycleState.RESERVED,
      TradeLifecycleState.RESERVATION_FAILED,
      TradeLifecycleState.TRADE_FAILED,
      TradeLifecycleState.TRADE_CANCELLED,
    ],
    [TradeLifecycleState.TRADE_REJECTED]: [], // Terminal
    [TradeLifecycleState.RESERVATION_CREATED]: [
      TradeLifecycleState.RESERVED,
      TradeLifecycleState.ORDER_SUBMITTED,
      TradeLifecycleState.RESERVATION_FAILED,
      TradeLifecycleState.TRADE_FAILED,
      TradeLifecycleState.TRADE_CANCELLED,
    ],
    [TradeLifecycleState.RESERVED]: [
      TradeLifecycleState.ORDER_SUBMITTED,
      TradeLifecycleState.RESERVATION_FAILED,
      TradeLifecycleState.TRADE_FAILED,
      TradeLifecycleState.TRADE_CANCELLED,
    ],
    [TradeLifecycleState.RESERVATION_FAILED]: [
      TradeLifecycleState.TRADE_FAILED,
      TradeLifecycleState.TRADE_REJECTED,
      TradeLifecycleState.TRADE_CANCELLED,
    ],
    [TradeLifecycleState.ORDER_SUBMITTED]: [
      TradeLifecycleState.ORDER_PARTIALLY_FILLED,
      TradeLifecycleState.ORDER_FILLED,
      TradeLifecycleState.POSITION_OPENED,
      TradeLifecycleState.ORDER_REJECTED,
      TradeLifecycleState.TRADE_FAILED,
      TradeLifecycleState.TRADE_CANCELLED,
      TradeLifecycleState.RECONCILIATION_REQUIRED,
    ],
    [TradeLifecycleState.ORDER_REJECTED]: [
      TradeLifecycleState.TRADE_FAILED,
      TradeLifecycleState.TRADE_CANCELLED,
    ],
    [TradeLifecycleState.ORDER_PARTIALLY_FILLED]: [
      TradeLifecycleState.ORDER_FILLED,
      TradeLifecycleState.POSITION_OPENED,
      TradeLifecycleState.TRADE_FAILED,
      TradeLifecycleState.TRADE_CANCELLED,
      TradeLifecycleState.RECONCILIATION_REQUIRED,
    ],
    [TradeLifecycleState.ORDER_FILLED]: [
      TradeLifecycleState.POSITION_OPENED,
      TradeLifecycleState.TRADE_FAILED,
      TradeLifecycleState.RECONCILIATION_REQUIRED,
    ],
    [TradeLifecycleState.POSITION_OPENED]: [
      TradeLifecycleState.TP1_TRIGGERED,
      TradeLifecycleState.TP1_PARTIAL_FILLED,
      TradeLifecycleState.POSITION_PARTIALLY_CLOSED,
      TradeLifecycleState.SL_MOVED_TO_BREAKEVEN,
      TradeLifecycleState.TRAILING,
      TradeLifecycleState.EXIT_TRIGGERED,
      TradeLifecycleState.EXIT_PENDING,
      TradeLifecycleState.EXIT_SUBMITTED,
      TradeLifecycleState.POSITION_CLOSED,
      TradeLifecycleState.TRADE_CLOSED,
      TradeLifecycleState.TRADE_FAILED,
      TradeLifecycleState.RECONCILIATION_REQUIRED,
    ],
    [TradeLifecycleState.TP1_TRIGGERED]: [
      TradeLifecycleState.TP1_PARTIAL_FILLED,
      TradeLifecycleState.POSITION_PARTIALLY_CLOSED,
      TradeLifecycleState.SL_MOVED_TO_BREAKEVEN,
      TradeLifecycleState.EXIT_TRIGGERED,
      TradeLifecycleState.TRADE_FAILED,
      TradeLifecycleState.RECONCILIATION_REQUIRED,
    ],
    [TradeLifecycleState.TP1_PARTIAL_FILLED]: [
      TradeLifecycleState.POSITION_PARTIALLY_CLOSED,
      TradeLifecycleState.SL_MOVED_TO_BREAKEVEN,
      TradeLifecycleState.TP2_TRIGGERED,
      TradeLifecycleState.TP2_PARTIAL_FILLED,
      TradeLifecycleState.EXIT_TRIGGERED,
      TradeLifecycleState.POSITION_CLOSED,
      TradeLifecycleState.TRADE_CLOSED,
      TradeLifecycleState.TRADE_FAILED,
      TradeLifecycleState.RECONCILIATION_REQUIRED,
    ],
    [TradeLifecycleState.POSITION_PARTIALLY_CLOSED]: [
      TradeLifecycleState.SL_MOVED_TO_BREAKEVEN,
      TradeLifecycleState.TP2_TRIGGERED,
      TradeLifecycleState.TP2_PARTIAL_FILLED,
      TradeLifecycleState.TRAILING,
      TradeLifecycleState.TP3_TRIGGERED,
      TradeLifecycleState.EXIT_TRIGGERED,
      TradeLifecycleState.EXIT_PENDING,
      TradeLifecycleState.EXIT_SUBMITTED,
      TradeLifecycleState.POSITION_CLOSED,
      TradeLifecycleState.TRADE_CLOSED,
      TradeLifecycleState.TRADE_FAILED,
      TradeLifecycleState.RECONCILIATION_REQUIRED,
    ],
    [TradeLifecycleState.SL_MOVED_TO_BREAKEVEN]: [
      TradeLifecycleState.TP2_TRIGGERED,
      TradeLifecycleState.TP2_PARTIAL_FILLED,
      TradeLifecycleState.TRAILING,
      TradeLifecycleState.TP3_TRIGGERED,
      TradeLifecycleState.EXIT_TRIGGERED,
      TradeLifecycleState.EXIT_PENDING,
      TradeLifecycleState.POSITION_CLOSED,
      TradeLifecycleState.TRADE_CLOSED,
      TradeLifecycleState.RECONCILIATION_REQUIRED,
    ],
    [TradeLifecycleState.TP2_TRIGGERED]: [
      TradeLifecycleState.TP2_PARTIAL_FILLED,
      TradeLifecycleState.POSITION_PARTIALLY_CLOSED,
      TradeLifecycleState.TRAILING,
      TradeLifecycleState.TP3_TRIGGERED,
      TradeLifecycleState.EXIT_TRIGGERED,
      TradeLifecycleState.POSITION_CLOSED,
      TradeLifecycleState.TRADE_CLOSED,
      TradeLifecycleState.RECONCILIATION_REQUIRED,
    ],
    [TradeLifecycleState.TP2_PARTIAL_FILLED]: [
      TradeLifecycleState.POSITION_PARTIALLY_CLOSED,
      TradeLifecycleState.TRAILING,
      TradeLifecycleState.TP3_TRIGGERED,
      TradeLifecycleState.EXIT_TRIGGERED,
      TradeLifecycleState.POSITION_CLOSED,
      TradeLifecycleState.TRADE_CLOSED,
      TradeLifecycleState.RECONCILIATION_REQUIRED,
    ],
    [TradeLifecycleState.TRAILING]: [
      TradeLifecycleState.TP3_TRIGGERED,
      TradeLifecycleState.EXIT_TRIGGERED,
      TradeLifecycleState.EXIT_PENDING,
      TradeLifecycleState.POSITION_CLOSED,
      TradeLifecycleState.TRADE_CLOSED,
      TradeLifecycleState.RECONCILIATION_REQUIRED,
    ],
    [TradeLifecycleState.TP3_TRIGGERED]: [
      TradeLifecycleState.EXIT_TRIGGERED,
      TradeLifecycleState.EXIT_PENDING,
      TradeLifecycleState.EXIT_SUBMITTED,
      TradeLifecycleState.POSITION_CLOSED,
      TradeLifecycleState.TRADE_CLOSED,
      TradeLifecycleState.RECONCILIATION_REQUIRED,
    ],
    [TradeLifecycleState.EXIT_TRIGGERED]: [
      TradeLifecycleState.EXIT_PENDING,
      TradeLifecycleState.EXIT_SUBMITTED,
      TradeLifecycleState.EXIT_FILLED,
      TradeLifecycleState.POSITION_CLOSED,
      TradeLifecycleState.TRADE_CLOSED,
      TradeLifecycleState.TRADE_FAILED,
      TradeLifecycleState.RECONCILIATION_REQUIRED,
    ],
    [TradeLifecycleState.EXIT_PENDING]: [
      TradeLifecycleState.EXIT_SUBMITTED,
      TradeLifecycleState.EXIT_FILLED,
      TradeLifecycleState.POSITION_CLOSED,
      TradeLifecycleState.TRADE_CLOSED,
      TradeLifecycleState.TRADE_FAILED,
      TradeLifecycleState.RECONCILIATION_REQUIRED,
    ],
    [TradeLifecycleState.EXIT_SUBMITTED]: [
      TradeLifecycleState.EXIT_FILLED,
      TradeLifecycleState.POSITION_CLOSED,
      TradeLifecycleState.TRADE_CLOSED,
      TradeLifecycleState.TRADE_FAILED,
      TradeLifecycleState.RECONCILIATION_REQUIRED,
    ],
    [TradeLifecycleState.EXIT_FILLED]: [
      TradeLifecycleState.POSITION_CLOSED,
      TradeLifecycleState.TRADE_CLOSED,
      TradeLifecycleState.TRADE_FAILED,
      TradeLifecycleState.RECONCILIATION_REQUIRED,
    ],
    [TradeLifecycleState.POSITION_CLOSED]: [
      TradeLifecycleState.TRADE_CLOSED,
      TradeLifecycleState.TRADE_FAILED,
      TradeLifecycleState.RECONCILIATION_REQUIRED,
    ],
    [TradeLifecycleState.RECONCILIATION_REQUIRED]: [
      TradeLifecycleState.POSITION_OPENED,
      TradeLifecycleState.POSITION_PARTIALLY_CLOSED,
      TradeLifecycleState.POSITION_CLOSED,
      TradeLifecycleState.ORDER_FILLED,
      TradeLifecycleState.ORDER_PARTIALLY_FILLED,
      TradeLifecycleState.TRADE_CLOSED,
      TradeLifecycleState.TRADE_FAILED,
    ],
    [TradeLifecycleState.TRADE_CLOSED]: [], // Terminal
    [TradeLifecycleState.TRADE_FAILED]: [], // Terminal
    [TradeLifecycleState.TRADE_CANCELLED]: [], // Terminal
  };

  private readonly TERMINAL_STATES: ReadonlySet<TradeLifecycleState> = new Set([
    TradeLifecycleState.TRADE_CLOSED,
    TradeLifecycleState.TRADE_REJECTED,
    TradeLifecycleState.TRADE_FAILED,
    TradeLifecycleState.TRADE_CANCELLED,
  ]);

  constructor(private readonly prisma: PrismaService) {}

  public isTerminalState(state: TradeLifecycleState | string): boolean {
    return this.TERMINAL_STATES.has(state as TradeLifecycleState);
  }

  public async getLifecycleState(
    tradeDecisionId: string,
    txClient?: any,
  ): Promise<TradeLifecycleState | null> {
    const db = txClient || this.prisma;
    const decision = await db.tradeDecision.findUnique({
      where: { id: tradeDecisionId },
      select: { lifecycleState: true },
    });
    return (decision?.lifecycleState as TradeLifecycleState) ?? null;
  }

  public isValidTransition(fromState: TradeLifecycleState, toState: TradeLifecycleState): boolean {
    if (fromState === toState) return true; // Idempotent same-state
    const allowed = this.ALLOWED_TRANSITIONS[fromState] || [];
    return allowed.includes(toState);
  }

  public getAllowedNextStates(state: TradeLifecycleState): TradeLifecycleState[] {
    return this.ALLOWED_TRANSITIONS[state] || [];
  }

  /**
   * One authoritative transition function.
   * No direct mutation of lifecycle states is permitted without passing through this FSM.
   */
  public async transition(
    request: LifecycleTransitionRequest,
    txClient?: any,
  ): Promise<LifecycleTransitionResponse> {
    const db = txClient || this.prisma;
    const {
      tradeDecisionId,
      expectedState,
      expectedVersion,
      newState,
      event,
      correlationId,
      metadata,
    } = request;

    const decision = await db.tradeDecision.findUnique({
      where: { id: tradeDecisionId },
    });

    if (!decision) {
      throw new NotFoundException(`[LIFECYCLE_TRANSITION_FAILED] TradeDecision '${tradeDecisionId}' not found`);
    }

    const currentState = decision.lifecycleState as TradeLifecycleState;

    // Resolve allowed expected states
    let allowedExpected: TradeLifecycleState[];
    if (expectedState) {
      allowedExpected = Array.isArray(expectedState) ? expectedState : [expectedState];
      if (!allowedExpected.includes(currentState)) {
        throw new BadRequestException(
          `[LIFECYCLE_TRANSITION_FAILED] LIFECYCLE_CONFLICT: Current state '${currentState}' is not in expected state(s) [${allowedExpected.join(', ')}] for transition to '${newState}'`,
        );
      }
    } else {
      // Automatically derive all valid source states that can transition to newState in the authoritative FSM
      allowedExpected = (Object.keys(this.ALLOWED_TRANSITIONS) as TradeLifecycleState[]).filter(
        (src) => this.ALLOWED_TRANSITIONS[src]?.includes(newState),
      );
    }

    // Verify expectedVersion if specified
    if (expectedVersion !== undefined && typeof decision.version === 'number') {
      if (decision.version !== expectedVersion) {
        throw new BadRequestException(
          `[LIFECYCLE_TRANSITION_FAILED] LIFECYCLE_CONFLICT: Version mismatch. Expected version ${expectedVersion}, but found ${decision.version}`,
        );
      }
    }

    // Idempotent self-transition
    if (currentState === newState) {
      this.logger.debug(
        `[LIFECYCLE IDEMPOTENT] tradeDecisionId=${tradeDecisionId} | already in state '${newState}'`,
      );
      return {
        success: true,
        tradeDecisionId,
        previousState: currentState,
        currentState: newState,
        transitionTime: new Date(),
        version: decision.version,
      };
    }

    // Verify FSM transition validity
    if (!this.isValidTransition(currentState, newState)) {
      throw new BadRequestException(
        `[INVALID_LIFECYCLE_TRANSITION] Cannot transition from '${currentState}' to '${newState}' on event '${event}'`,
      );
    }

    const now = new Date();

    // Prepare update payload with authoritative milestone timestamps
    const updateData: any = {
      lifecycleState: newState,
    };

    if (typeof decision.version === 'number') {
      updateData.version = { increment: 1 };
    }

    if (newState === TradeLifecycleState.SIGNAL_DETECTED) {
      updateData.observedAt = now;
      if (!decision.marketEventTime) updateData.marketEventTime = now;
    } else if (newState === TradeLifecycleState.SIGNAL_VALIDATED) {
      updateData.canonicalDecisionTime = now;
    } else if (newState === TradeLifecycleState.TRADE_TAKEN) {
      updateData.tradeTakenAt = now;
      updateData.tradeTakenTime = now;
    } else if (newState === TradeLifecycleState.RESERVATION_CREATED || newState === TradeLifecycleState.RESERVED) {
      updateData.reservationCreatedAt = now;
      updateData.reservationTime = now;
    } else if (newState === TradeLifecycleState.ORDER_SUBMITTED) {
      updateData.orderSubmittedAt = now;
      updateData.orderSubmittedTime = now;
    } else if (newState === TradeLifecycleState.ORDER_FILLED) {
      updateData.firstFillAt = now;
      updateData.fillTime = now;
    } else if (newState === TradeLifecycleState.POSITION_OPENED) {
      updateData.positionOpenedAt = now;
    } else if (newState === TradeLifecycleState.TRADE_CLOSED) {
      updateData.decisionTime = now;
    }

    if (metadata) {
      if (metadata.executionId) updateData.executionId = metadata.executionId;
      if (metadata.orderPositionId) updateData.orderPositionId = metadata.orderPositionId;
      if (metadata.marketEventTime) updateData.marketEventTime = metadata.marketEventTime;
      if (metadata.canonicalDecisionTime) updateData.canonicalDecisionTime = metadata.canonicalDecisionTime;
      if (metadata.tradeTakenTime) updateData.tradeTakenTime = metadata.tradeTakenTime;
      if (metadata.tradeTakenAt) updateData.tradeTakenAt = metadata.tradeTakenAt;
      if (metadata.reservationCreatedAt) updateData.reservationCreatedAt = metadata.reservationCreatedAt;
      if (metadata.reservationTime) updateData.reservationTime = metadata.reservationTime;
      if (metadata.orderSubmittedAt) updateData.orderSubmittedAt = metadata.orderSubmittedAt;
      if (metadata.orderSubmittedTime) updateData.orderSubmittedTime = metadata.orderSubmittedTime;
      if (metadata.firstFillAt) updateData.firstFillAt = metadata.firstFillAt;
      if (metadata.fillTime) updateData.fillTime = metadata.fillTime;
      if (metadata.positionOpenedAt) updateData.positionOpenedAt = metadata.positionOpenedAt;
      if (metadata.decisionTime) updateData.decisionTime = metadata.decisionTime;
      if (metadata.decisionReasonCode) updateData.decisionReasonCode = metadata.decisionReasonCode;
      if (metadata.decisionReason) updateData.decisionReason = metadata.decisionReason;
    }

    // Atomic Compare-And-Swap (CAS) update
    const casWhere: any = {
      id: tradeDecisionId,
      lifecycleState: allowedExpected.length === 1 ? allowedExpected[0] : { in: allowedExpected },
    };
    if (expectedVersion !== undefined) {
      casWhere.version = expectedVersion;
    }

    let updatedCount = 0;
    if (typeof db.tradeDecision.updateMany === 'function') {
      const res = await db.tradeDecision.updateMany({
        where: casWhere,
        data: updateData,
      });
      updatedCount = res?.count ?? 0;
    } else if (typeof db.tradeDecision.update === 'function') {
      // Fallback for mock environments lacking updateMany
      await db.tradeDecision.update({
        where: { id: tradeDecisionId },
        data: updateData,
      });
      updatedCount = 1;
    }

    if (updatedCount === 0) {
      // CAS collision or stale state: refetch record to determine actual outcome
      const fresh = await db.tradeDecision.findUnique({
        where: { id: tradeDecisionId },
      });

      if (!fresh) {
        throw new NotFoundException(
          `[LIFECYCLE_TRANSITION_FAILED] TradeDecision '${tradeDecisionId}' deleted during transition`,
        );
      }

      if (fresh.lifecycleState === newState) {
        // Idempotent: another concurrent worker already completed this transition
        this.logger.debug(
          `[LIFECYCLE CAS IDEMPOTENT] tradeDecisionId=${tradeDecisionId} | already transitioned to '${newState}' by concurrent worker`,
        );
        return {
          success: true,
          tradeDecisionId,
          previousState: currentState,
          currentState: newState,
          transitionTime: fresh.updatedAt || new Date(),
          version: fresh.version,
        };
      }

      // Conflicting state transition occurred concurrently
      throw new BadRequestException(
        `[LIFECYCLE_TRANSITION_FAILED] LIFECYCLE_CONFLICT: CAS mismatch. Current state '${fresh.lifecycleState}' is not in expected state(s) [${allowedExpected.join(', ')}] for transition to '${newState}'`,
      );
    }

    const nextVersion = typeof decision.version === 'number' ? decision.version + 1 : undefined;

    this.logger.log(
      `[LIFECYCLE TRANSITION] tradeDecisionId=${tradeDecisionId} | ${currentState} -> ${newState} | event=${event} | corr=${correlationId}${nextVersion !== undefined ? ` | v=${nextVersion}` : ''}`,
    );

    return {
      success: true,
      tradeDecisionId,
      previousState: currentState,
      currentState: newState,
      transitionTime: now,
      version: nextVersion,
    };
  }
}
