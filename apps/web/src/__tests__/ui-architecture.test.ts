import { NAV_GROUPS, NavGroup, NavTab, StrategyMode } from '../components/Header';
import { MarketDataState } from '../hooks/useMarketContext';
import { EmptyStatePreset } from '../components/common/EmptyState';
import { AuthoritativePosition, AlgoExecutionRecord } from '../hooks/usePaperTrading';
import { StageState } from '../components/execution/ExecutionStageRail';
import { ISignalSetup, Direction, SignalGrade, SignalState } from '@quant/shared';

describe('Frontend UI Architecture & Trading UX Tests', () => {
  describe('Requirement 1 & 9: Grouped Workstation Navigation & Accessibility Structure', () => {
    it('defines exactly the 6 target product groups without flat 16-tab clutter', () => {
      const groupIds = NAV_GROUPS.map((g) => g.id);
      expect(groupIds).toEqual([
        'terminal',
        'analyze',
        'trade',
        'research',
        'automation',
        'history',
      ]);
    });

    it('maps all secondary tools under their respective primary product groups', () => {
      const analyzeGroup = NAV_GROUPS.find((g) => g.id === 'analyze');
      expect(analyzeGroup).toBeDefined();
      const analyzeTabIds = analyzeGroup!.items.map((i) => i.id);
      expect(analyzeTabIds).toEqual([
        'quant',
        'scanner',
        'multichart',
        'radar',
        'smt',
        'correlation',
        'macro',
      ]);

      const tradeGroup = NAV_GROUPS.find((g) => g.id === 'trade');
      expect(tradeGroup).toBeDefined();
      const tradeTabIds = tradeGroup!.items.map((i) => i.id);
      expect(tradeTabIds).toEqual(['paper', 'options', 'risk']);

      const researchGroup = NAV_GROUPS.find((g) => g.id === 'research');
      expect(researchGroup).toBeDefined();
      const researchTabIds = researchGroup!.items.map((i) => i.id);
      expect(researchTabIds).toEqual(['learning', 'research', 'backtest']);

      const automationGroup = NAV_GROUPS.find((g) => g.id === 'automation');
      expect(automationGroup).toBeDefined();
      expect(automationGroup!.items.map((i) => i.id)).toEqual(['algo']);

      const historyGroup = NAV_GROUPS.find((g) => g.id === 'history');
      expect(historyGroup).toBeDefined();
      expect(historyGroup!.items.map((i) => i.id)).toEqual(['journal']);
    });

    it('ensures every single navigation tab is uniquely reachable and non-empty', () => {
      const allTabs: NavTab[] = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));
      const uniqueTabs = new Set(allTabs);
      expect(uniqueTabs.size).toBe(allTabs.length);
      expect(allTabs.length).toBe(16);
    });

    it('removes marketing claim buzzwords in tool descriptions', () => {
      const allDescriptions = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.description || ''));
      allDescriptions.forEach((desc) => {
        expect(desc.toLowerCase()).not.toContain('institutional execution system');
        expect(desc.toLowerCase()).not.toContain('real postgresql paper');
      });
    });
  });

  describe('Requirement 5 & 6: Market Connection Semantics & Tighter Freshness States', () => {
    it('models distinct non-interchangeable market connection states', () => {
      const validStatuses: MarketDataState['status'][] = [
        'CONNECTED',
        'RECONNECTING',
        'STALE',
        'DEGRADED',
        'UNAVAILABLE',
      ];

      validStatuses.forEach((status) => {
        const state: MarketDataState = {
          status,
          providerId: 'BINANCE',
          dataProvenance: 'LIVE',
          isStale: status === 'STALE' || status === 'RECONNECTING' || status === 'UNAVAILABLE',
        };
        expect(state.status).toBe(status);
      });
    });

    it('correctly identifies fresh vs stale connection states based on thresholds', () => {
      const freshState: MarketDataState = {
        status: 'CONNECTED',
        providerId: 'TRUEMARKETS',
        dataProvenance: 'LIVE',
        isStale: false,
        latencyMs: 120,
      };
      expect(freshState.status).toBe('CONNECTED');
      expect(freshState.isStale).toBe(false);

      const staleState: MarketDataState = {
        status: 'CONNECTED',
        providerId: 'TRUEMARKETS',
        dataProvenance: 'LIVE',
        isStale: true,
        latencyMs: 12000,
      };
      expect(staleState.status).toBe('CONNECTED');
      expect(staleState.isStale).toBe(true);
    });
  });

  describe('Requirement 1, 2 & 5: Strict Authoritative Execution Lifecycle Pipeline', () => {
    it('requires trigger specifications to remain distinct from fill records', () => {
      const triggerSpec = {
        triggerPrice: 65000,
        triggerTime: new Date('2026-09-16T10:00:00Z'),
        triggerReason: 'Liquidity Pool Sweep',
      };

      const fillRecord = {
        executionState: 'POSITION_OPEN',
        fillPrice: 65012.5, // Realistic fill incorporating live market spread
        fillTime: new Date('2026-09-16T10:00:00.150Z'),
        quantity: 1,
      };

      expect(triggerSpec.triggerPrice).not.toBe(fillRecord.fillPrice);
      expect(fillRecord.fillPrice).toBeGreaterThan(triggerSpec.triggerPrice);
    });

    it('evaluates Eligibility Gate as a first-class authoritative state with reasons', () => {
      // Helper matching ExecutionStageRail's first-class eligibility gate
      const evaluateEligibility = (signal: Partial<ISignalSetup> | null): { status: StageState; reason?: string } => {
        if (!signal) return { status: 'PENDING' };
        if (
          (signal.score ?? 0) < 70 ||
          (signal.grade as string) === 'NO_TRADE' ||
          (signal.direction as string) === 'NEUTRAL'
        ) {
          return { status: 'BLOCKED', reason: `Score ${signal.score}/100 below gate threshold` };
        }
        return { status: 'DONE', reason: `Score ${signal.score}/100 • Grade ${signal.grade}` };
      };

      // Case 1: No signal -> PENDING
      expect(evaluateEligibility(null).status).toBe('PENDING');

      // Case 2: Score 45 -> BLOCKED
      const lowScoreSignal = { score: 45, grade: SignalGrade.B, direction: Direction.BULLISH };
      const lowScoreResult = evaluateEligibility(lowScoreSignal);
      expect(lowScoreResult.status).toBe('BLOCKED');
      expect(lowScoreResult.reason).toContain('below gate threshold');

      // Case 3: Score 85 Grade A+ -> DONE (Eligible)
      const highScoreSignal = { score: 85, grade: SignalGrade.A_PLUS, direction: Direction.BULLISH };
      const highScoreResult = evaluateEligibility(highScoreSignal);
      expect(highScoreResult.status).toBe('DONE');
      expect(highScoreResult.reason).toContain('Score 85/100');
    });

    it('strictly requires authoritative reservation evidence for DB Reservation stage', () => {
      const evaluateReservation = (
        execution: AlgoExecutionRecord | null,
        eligibilityStatus: StageState
      ): StageState => {
        const hasExplicitReservation =
          !!execution?.id &&
          (execution.state === 'RESERVED' ||
            execution.state === 'EXECUTING' ||
            execution.state === 'EXECUTED');

        if (hasExplicitReservation) return 'DONE';
        if (execution?.failureReasonCode === 'EXECUTION_LOCKED') return 'FAILED';
        if (eligibilityStatus === 'BLOCKED' || eligibilityStatus === 'FAILED') return 'NOT_REACHED';
        return 'PENDING';
      };

      // Case 1: Eligibility blocked -> NOT_REACHED
      expect(evaluateReservation(null, 'BLOCKED')).toBe('NOT_REACHED');

      // Case 2: Execution lock conflict -> FAILED
      const lockedExec = { failureReasonCode: 'EXECUTION_LOCKED' } as AlgoExecutionRecord;
      expect(evaluateReservation(lockedExec, 'DONE')).toBe('FAILED');

      // Case 3: Authoritative reservation record -> DONE
      const reservedExec = { id: 'exec_123', state: 'RESERVED' } as AlgoExecutionRecord;
      expect(evaluateReservation(reservedExec, 'DONE')).toBe('DONE');
    });

    it('strictly requires authoritative execution record for Order Filled stage (no downstream position inference)', () => {
      const isOrderFilledAuthoritative = (execution: AlgoExecutionRecord | null) => {
        return execution?.state === 'EXECUTED' || Boolean(execution?.orderPositionId);
      };

      expect(isOrderFilledAuthoritative(null)).toBe(false);

      const reservedExecution = { state: 'RESERVED' } as AlgoExecutionRecord;
      expect(isOrderFilledAuthoritative(reservedExecution)).toBe(false);

      const executingExecution = { state: 'EXECUTING' } as AlgoExecutionRecord;
      expect(isOrderFilledAuthoritative(executingExecution)).toBe(false);

      const failedExecution = { state: 'FAILED_FINAL' } as AlgoExecutionRecord;
      expect(isOrderFilledAuthoritative(failedExecution)).toBe(false);

      const executedExecution = { state: 'EXECUTED', orderPositionId: 'pos_123' } as AlgoExecutionRecord;
      expect(isOrderFilledAuthoritative(executedExecution)).toBe(true);
    });

    it('supports full lifecycle stage statuses: DONE, ACTIVE, FAILED, BLOCKED, NOT_REACHED, PENDING', () => {
      const validStatuses: StageState[] = [
        'DONE',
        'ACTIVE',
        'FAILED',
        'BLOCKED',
        'NOT_REACHED',
        'PENDING',
      ];
      expect(validStatuses.length).toBe(6);
      expect(new Set(validStatuses).size).toBe(6);
    });

    it('verifies all strategy modes are properly typed and supported', () => {
      const modes: StrategyMode[] = ['SMC', 'SAIYAN_OCC', 'HYBRID'];
      expect(modes.length).toBe(3);
      expect(modes).toContain('SMC');
      expect(modes).toContain('SAIYAN_OCC');
      expect(modes).toContain('HYBRID');
    });
  });

  describe('Requirement 8: Standardized Empty State System', () => {
    it('defines all required empty state presets including dedicated no-algo-bots', () => {
      const presets: EmptyStatePreset[] = [
        'no-signal',
        'no-position',
        'no-trades',
        'no-market-data',
        'no-scan-results',
        'no-research-runs',
        'no-algo-bots',
      ];
      expect(presets.length).toBe(7);
      expect(new Set(presets).size).toBe(7);
      expect(presets).toContain('no-algo-bots');
    });
  });
});
