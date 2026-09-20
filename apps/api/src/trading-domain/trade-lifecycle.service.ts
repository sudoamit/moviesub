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
    ],
    [TradeLifecycleState.ORDER_SUBMITTED]: [
      TradeLifecycleState.ORDER_PARTIALLY_FILLED,
      TradeLifecycleState.ORDER_FILLED,
      TradeLifecycleState.ORDER_REJECTED,
      TradeLifecycleState.TRADE_FAILED,
      TradeLifecycleState.TRADE_CANCELLED,
    ],
    [TradeLifecycleState.ORDER_REJECTED]: [
      TradeLifecycleState.TRADE_FAILED,
    ],
    [TradeLifecycleState.ORDER_PARTIALLY_FILLED]: [
      TradeLifecycleState.ORDER_FILLED,
      TradeLifecycleState.POSITION_OPENED,
      TradeLifecycleState.TRADE_FAILED,
      TradeLifecycleState.TRADE_CANCELLED,
    ],
    [TradeLifecycleState.ORDER_FILLED]: [
      TradeLifecycleState.POSITION_OPENED,
      TradeLifecycleState.TRADE_FAILED,
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
    ],
    [TradeLifecycleState.TP1_TRIGGERED]: [
      TradeLifecycleState.TP1_PARTIAL_FILLED,
      TradeLifecycleState.POSITION_PARTIALLY_CLOSED,
      TradeLifecycleState.SL_MOVED_TO_BREAKEVEN,
      TradeLifecycleState.EXIT_TRIGGERED,
      TradeLifecycleState.TRADE_FAILED,
    ],
    [TradeLifecycleState.TP1_PARTIAL_FILLED]: [
      TradeLifecycleState.POSITION_PARTIALLY_CLOSED,
      TradeLifecycleState.SL_MOVED_TO_BREAKEVEN,
      TradeLifecycleState.TP2_TRIGGERED,
      TradeLifecycleState.EXIT_TRIGGERED,
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
    ],
    [TradeLifecycleState.TP2_TRIGGERED]: [
      TradeLifecycleState.TP2_PARTIAL_FILLED,
      TradeLifecycleState.POSITION_PARTIALLY_CLOSED,
      TradeLifecycleState.TRAILING,
      TradeLifecycleState.TP3_TRIGGERED,
      TradeLifecycleState.EXIT_TRIGGERED,
      TradeLifecycleState.POSITION_CLOSED,
      TradeLifecycleState.TRADE_CLOSED,
    ],
    [TradeLifecycleState.TP2_PARTIAL_FILLED]: [
      TradeLifecycleState.POSITION_PARTIALLY_CLOSED,
      TradeLifecycleState.TRAILING,
      TradeLifecycleState.TP3_TRIGGERED,
      TradeLifecycleState.EXIT_TRIGGERED,
      TradeLifecycleState.POSITION_CLOSED,
      TradeLifecycleState.TRADE_CLOSED,
    ],
    [TradeLifecycleState.TRAILING]: [
      TradeLifecycleState.TP3_TRIGGERED,
      TradeLifecycleState.EXIT_TRIGGERED,
      TradeLifecycleState.EXIT_PENDING,
      TradeLifecycleState.POSITION_CLOSED,
      TradeLifecycleState.TRADE_CLOSED,
    ],
    [TradeLifecycleState.TP3_TRIGGERED]: [
      TradeLifecycleState.EXIT_TRIGGERED,
      TradeLifecycleState.EXIT_PENDING,
      TradeLifecycleState.EXIT_SUBMITTED,
      TradeLifecycleState.POSITION_CLOSED,
      TradeLifecycleState.TRADE_CLOSED,
    ],
    [TradeLifecycleState.EXIT_TRIGGERED]: [
      TradeLifecycleState.EXIT_PENDING,
      TradeLifecycleState.EXIT_SUBMITTED,
      TradeLifecycleState.EXIT_FILLED,
      TradeLifecycleState.POSITION_CLOSED,
      TradeLifecycleState.TRADE_CLOSED,
    ],
    [TradeLifecycleState.EXIT_PENDING]: [
      TradeLifecycleState.EXIT_SUBMITTED,
      TradeLifecycleState.EXIT_FILLED,
      TradeLifecycleState.POSITION_CLOSED,
      TradeLifecycleState.TRADE_CLOSED,
    ],
    [TradeLifecycleState.EXIT_SUBMITTED]: [
      TradeLifecycleState.EXIT_FILLED,
      TradeLifecycleState.POSITION_CLOSED,
      TradeLifecycleState.TRADE_CLOSED,
    ],
    [TradeLifecycleState.EXIT_FILLED]: [
      TradeLifecycleState.POSITION_CLOSED,
      TradeLifecycleState.TRADE_CLOSED,
    ],
    [TradeLifecycleState.POSITION_CLOSED]: [
      TradeLifecycleState.TRADE_CLOSED,
    ],
    [TradeLifecycleState.TRADE_CLOSED]: [], // Terminal
    [TradeLifecycleState.TRADE_FAILED]: [], // Terminal
    [TradeLifecycleState.TRADE_CANCELLED]: [], // Terminal
  };

  constructor(private readonly prisma: PrismaService) {}

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
  public async transition(request: LifecycleTransitionRequest): Promise<LifecycleTransitionResponse> {
    const { tradeDecisionId, expectedState, newState, event, correlationId, metadata } = request;

    const decision = await this.prisma.tradeDecision.findUnique({
      where: { id: tradeDecisionId },
    });

    if (!decision) {
      throw new NotFoundException(`TradeDecision '${tradeDecisionId}' not found`);
    }

    const currentState = decision.lifecycleState as TradeLifecycleState;

    // Verify expected state if specified
    if (expectedState) {
      const allowedExpected = Array.isArray(expectedState) ? expectedState : [expectedState];
      if (!allowedExpected.includes(currentState)) {
        throw new BadRequestException(
          `LIFECYCLE_CONFLICT: Current state '${currentState}' is not in expected state(s) [${allowedExpected.join(', ')}] for transition to '${newState}'`,
        );
      }
    }

    // Verify FSM transition validity
    if (!this.isValidTransition(currentState, newState)) {
      throw new BadRequestException(
        `INVALID_LIFECYCLE_TRANSITION: Cannot transition from '${currentState}' to '${newState}' on event '${event}'`,
      );
    }

    const now = new Date();

    // Prepare update payload
    const updateData: any = {
      lifecycleState: newState,
    };

    if (newState === TradeLifecycleState.ORDER_SUBMITTED) {
      updateData.orderSubmittedAt = now;
      updateData.orderSubmittedTime = now;
    } else if (newState === TradeLifecycleState.ORDER_FILLED) {
      updateData.firstFillAt = now;
      updateData.fillTime = now;
    } else if (newState === TradeLifecycleState.POSITION_OPENED) {
      updateData.positionOpenedAt = now;
    }

    if (metadata) {
      if (metadata.executionId) updateData.executionId = metadata.executionId;
      if (metadata.orderPositionId) updateData.orderPositionId = metadata.orderPositionId;
      if (metadata.marketEventTime) updateData.marketEventTime = metadata.marketEventTime;
    }

    await this.prisma.tradeDecision.update({
      where: { id: tradeDecisionId },
      data: updateData,
    });

    this.logger.log(
      `[LIFECYCLE TRANSITION] tradeDecisionId=${tradeDecisionId} | ${currentState} -> ${newState} | event=${event} | corr=${correlationId}`,
    );

    return {
      success: true,
      tradeDecisionId,
      previousState: currentState,
      currentState: newState,
      transitionTime: now,
    };
  }
}
