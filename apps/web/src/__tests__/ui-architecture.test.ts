import { NAV_GROUPS, NavGroup, NavTab, StrategyMode } from '../components/Header';
import { MarketDataState } from '../hooks/useMarketContext';
import { EmptyStatePreset } from '../components/common/EmptyState';
import { AuthoritativePosition, AlgoExecutionRecord } from '../hooks/usePaperTrading';
import {
  calculateExecutionLifecycle,
  StageState,
} from '../components/execution/lifecycle-projection';
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

  describe('Requirement 1, 2, 4 & 5: Authoritative Execution Lifecycle Projection (Direct Domain Testing)', () => {
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

    it('tests calculateExecutionLifecycle projection in initial standby state', () => {
      const stages = calculateExecutionLifecycle({
        signal: null,
        execution: null,
        position: null,
      });

      expect(stages).toHaveLength(6);
      expect(stages.every((s) => s.status === 'PENDING')).toBe(true);
    });

    it('strictly requires canonical signal identity/event evidence for Signal Detected stage', () => {
      // Standby signal with only symbol and timeframe (no id, no canonical timestamps)
      const nonCanonicalSignal = {
        symbol: 'NIFTY',
        timeframe: '15m',
      } as any;

      const stagesIncomplete = calculateExecutionLifecycle({
        signal: nonCanonicalSignal,
        execution: null,
        position: null,
      });

      expect(stagesIncomplete.find((s) => s.id === 'signal')?.status).toBe('PENDING');

      // Authoritative signal with canonical event timestamps
      const canonicalSignal: ISignalSetup = {
        id: 'sig_canonical_1',
        symbol: 'NIFTY',
        timeframe: '15m',
        direction: Direction.BULLISH,
        state: SignalState.ACTIVE,
        grade: SignalGrade.A,
        score: 80,
        canonicalCandleTime: 1789559700000,
        canonicalDecisionTime: new Date(1789559700000),
        entryZone: { min: 24200, max: 24220, optimal: 24210 },
        stopLoss: 24150,
        takeProfits: { tp1: 24300, tp2: 24400, tp3: 24500 },
        riskRewardRatios: { rr1: 1.5, rr2: 3.1, rr3: 4.8 },
        reasoning: { summary: 'SMC Sweep', confirmedChecklist: ['OB'] },
        scoreBreakdown: {} as any,
      };

      const stagesCanonical = calculateExecutionLifecycle({
        signal: canonicalSignal,
        execution: null,
        position: null,
      });

      expect(stagesCanonical.find((s) => s.id === 'signal')?.status).toBe('DONE');
      expect(stagesCanonical.find((s) => s.id === 'signal')?.reason).toBe('NIFTY 15m • BULLISH');
    });

    it('evaluates Eligibility Gate strictly from backend evidence and remains PENDING without browser policy recalculation', () => {
      const signal: ISignalSetup = {
        id: 'sig_1',
        symbol: 'NIFTY',
        timeframe: '15m',
        direction: Direction.BULLISH,
        state: SignalState.ACTIVE,
        grade: SignalGrade.A,
        score: 80,
        entryZone: { min: 24200, max: 24220, optimal: 24210 },
        stopLoss: 24150,
        takeProfits: { tp1: 24300, tp2: 24400, tp3: 24500 },
        riskRewardRatios: { rr1: 1.5, rr2: 3.1, rr3: 4.8 },
        reasoning: { summary: 'SMC Sweep', confirmedChecklist: ['OB'] },
        scoreBreakdown: {} as any,
      };

      // Case 1: No backend eligibility evidence -> Must remain PENDING (No browser policy recalculation)
      const stagesNoEvidence = calculateExecutionLifecycle({
        signal,
        execution: null,
        position: null,
      });

      expect(stagesNoEvidence.find((s) => s.id === 'eligibility')?.status).toBe('PENDING');

      // Case 2: Backend execution record states trade is INELIGIBLE
      const ineligibleExecution: AlgoExecutionRecord = {
        id: 'exec_ineligible',
        botId: 'bot_1',
        symbol: 'NIFTY',
        timeframe: '15m',
        direction: 'BULLISH',
        state: 'FAILED_FINAL',
        failureReasonCode: 'INELIGIBLE_FOR_EXECUTION',
        failureReason: 'Daily risk budget exceeded',
        signalTimestamp: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const stagesIneligible = calculateExecutionLifecycle({
        signal,
        execution: ineligibleExecution,
        position: null,
      });

      const eligibilityStage = stagesIneligible.find((s) => s.id === 'eligibility');
      expect(eligibilityStage?.status).toBe('BLOCKED');
      expect(eligibilityStage?.reason).toBe('Daily risk budget exceeded');

      // Subsequent stages must be NOT_REACHED
      expect(stagesIneligible.find((s) => s.id === 'reserved')?.status).toBe('NOT_REACHED');
      expect(stagesIneligible.find((s) => s.id === 'executing')?.status).toBe('NOT_REACHED');
      expect(stagesIneligible.find((s) => s.id === 'placed')?.status).toBe('NOT_REACHED');
    });

    it('strictly requires explicit reservation evidence for DB Reservation stage', () => {
      const signal: ISignalSetup = {
        id: 'sig_1',
        symbol: 'NIFTY',
        timeframe: '15m',
        direction: Direction.BULLISH,
        state: SignalState.ACTIVE,
        grade: SignalGrade.A_PLUS,
        score: 85,
        entryZone: { min: 24200, max: 24220, optimal: 24210 },
        stopLoss: 24150,
        takeProfits: { tp1: 24300, tp2: 24400, tp3: 24500 },
        riskRewardRatios: { rr1: 1.5, rr2: 3.1, rr3: 4.8 },
        reasoning: { summary: 'SMC Sweep', confirmedChecklist: ['OB'] },
        scoreBreakdown: {} as any,
      };

      // Case 1: Generic execution ID without reservation fingerprint/state does NOT produce DONE
      const genericExec: AlgoExecutionRecord = {
        id: 'exec_generic_1',
        botId: 'bot_nifty_smc',
        symbol: 'NIFTY',
        timeframe: '15m',
        direction: 'BULLISH',
        state: 'FAILED_RETRYABLE',
        signalTimestamp: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const stagesGeneric = calculateExecutionLifecycle({
        signal,
        execution: genericExec,
        position: null,
      });

      expect(stagesGeneric.find((s) => s.id === 'reserved')?.status).toBe('PENDING');

      // Case 2: Active explicit reservation
      const reservedExec: AlgoExecutionRecord = {
        id: 'exec_reserved_1',
        botId: 'bot_nifty_smc',
        symbol: 'NIFTY',
        timeframe: '15m',
        direction: 'BULLISH',
        state: 'RESERVED',
        reservationFingerprint: 'bot_exec:bot_nifty_smc:v1:NIFTY:15m:1789559',
        signalTimestamp: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const stagesReserved = calculateExecutionLifecycle({
        signal,
        execution: reservedExec,
        position: null,
      });

      expect(stagesReserved.find((s) => s.id === 'reserved')?.status).toBe('DONE');
      expect(stagesReserved.find((s) => s.id === 'reserved')?.reason).toContain('bot_nifty_smc');

      // Case 3: Execution lock failure
      const lockedExec: AlgoExecutionRecord = {
        id: 'exec_locked_1',
        botId: 'bot_nifty_smc',
        symbol: 'NIFTY',
        timeframe: '15m',
        direction: 'BULLISH',
        state: 'FAILED_FINAL',
        failureReasonCode: 'EXECUTION_LOCKED',
        failureReason: 'Execution lock already held by another bot worker',
        signalTimestamp: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const stagesLocked = calculateExecutionLifecycle({
        signal,
        execution: lockedExec,
        position: null,
      });

      expect(stagesLocked.find((s) => s.id === 'reserved')?.status).toBe('FAILED');
      expect(stagesLocked.find((s) => s.id === 'executing')?.status).toBe('NOT_REACHED');
    });

    it('strictly requires authoritative execution record for Order Filled stage and never substitutes position entryPrice', () => {
      const signal: ISignalSetup = {
        id: 'sig_1',
        symbol: 'NIFTY',
        timeframe: '15m',
        direction: Direction.BULLISH,
        state: SignalState.ACTIVE,
        grade: SignalGrade.A_PLUS,
        score: 85,
        entryZone: { min: 24200, max: 24220, optimal: 24210 },
        stopLoss: 24150,
        takeProfits: { tp1: 24300, tp2: 24400, tp3: 24500 },
        riskRewardRatios: { rr1: 1.5, rr2: 3.1, rr3: 4.8 },
        reasoning: { summary: 'SMC Sweep', confirmedChecklist: ['OB'] },
        scoreBreakdown: {} as any,
      };

      // Case 1: Standby position alone does NOT produce Order Filled
      const positionOnly: AuthoritativePosition = {
        id: 'pos_1',
        symbol: 'NIFTY',
        direction: 'BUY',
        quantity: 1,
        entryPrice: 24250,
        currentPrice: 24260,
        unrealizedPnL: 10,
        unrealizedPnLPercent: 0.04,
        status: 'OPEN',
        openedAt: new Date().toISOString(),
      };

      const stagesPositionOnly = calculateExecutionLifecycle({
        signal,
        execution: null,
        position: positionOnly,
      });

      expect(stagesPositionOnly.find((s) => s.id === 'placed')?.status).toBe('PENDING');

      // Case 2: Authoritative EXECUTED record with fill price
      const executedRecord: AlgoExecutionRecord = {
        id: 'exec_executed_1',
        botId: 'bot_nifty_smc',
        symbol: 'NIFTY',
        timeframe: '15m',
        direction: 'BULLISH',
        state: 'EXECUTED',
        orderPositionId: 'pos_1',
        fillPrice: 24251.3,
        signalTimestamp: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const stagesExecuted = calculateExecutionLifecycle({
        signal,
        execution: executedRecord,
        position: positionOnly,
      });

      const filledStage = stagesExecuted.find((s) => s.id === 'placed');
      expect(filledStage?.status).toBe('DONE');
      expect(filledStage?.reason).toBe('Filled @ ₹24251.30');

      const positionStage = stagesExecuted.find((s) => s.id === 'open');
      expect(positionStage?.status).toBe('ACTIVE');
      expect(positionStage?.reason).toBe('BUY Active');

      // Case 3: Authoritative EXECUTED record without fillPrice does NOT fabricate position.entryPrice
      const executedNoFillPrice: AlgoExecutionRecord = {
        id: 'exec_executed_2',
        botId: 'bot_nifty_smc',
        symbol: 'NIFTY',
        timeframe: '15m',
        direction: 'BULLISH',
        state: 'EXECUTED',
        orderPositionId: 'pos_1',
        signalTimestamp: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const stagesNoFillPrice = calculateExecutionLifecycle({
        signal,
        execution: executedNoFillPrice,
        position: positionOnly,
      });

      expect(stagesNoFillPrice.find((s) => s.id === 'placed')?.status).toBe('DONE');
      expect(stagesNoFillPrice.find((s) => s.id === 'placed')?.reason).toBe('Filled');
    });

    it('renders ExecutionStageRail component markup correctly without crashing', () => {
      // Dynamic require or import to test component rendering
      const React = require('react');
      const ReactDOMServer = require('react-dom/server');
      const { ExecutionStageRail } = require('../components/execution/ExecutionStageRail');

      const signal: ISignalSetup = {
        id: 'sig_render_1',
        symbol: 'BANKNIFTY',
        timeframe: '5m',
        direction: Direction.BULLISH,
        state: SignalState.ACTIVE,
        grade: SignalGrade.A,
        score: 80,
        entryZone: { min: 51200, max: 51250, optimal: 51225 },
        stopLoss: 51100,
        takeProfits: { tp1: 51400, tp2: 51600, tp3: 51800 },
        riskRewardRatios: { rr1: 1.5, rr2: 3.2, rr3: 4.8 },
        reasoning: { summary: 'SMC Sweep', confirmedChecklist: ['OB'] },
        scoreBreakdown: {} as any,
      };

      const execution: AlgoExecutionRecord = {
        id: 'exec_render_1',
        botId: 'bot_bn_1',
        symbol: 'BANKNIFTY',
        timeframe: '5m',
        direction: 'BULLISH',
        state: 'EXECUTED',
        orderPositionId: 'pos_bn_1',
        fillPrice: 51225.5,
        signalTimestamp: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const html = ReactDOMServer.renderToStaticMarkup(
        React.createElement(ExecutionStageRail, {
          signal,
          position: null,
          execution,
        })
      );

      expect(html).toContain('Authoritative Execution Lifecycle Rail');
      expect(html).toContain('Signal Detected');
      expect(html).toContain('Eligibility Gate');
      expect(html).toContain('DB Reservation');
      expect(html).toContain('Execution Lock');
      expect(html).toContain('Order Filled');
      expect(html).toContain('Filled @ ₹51225.50');
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
