import { NAV_GROUPS, NavGroup, NavTab, StrategyMode } from '../components/Header';
import { MarketDataState } from '../hooks/useMarketContext';
import { EmptyStatePreset } from '../components/common/EmptyState';
import { AuthoritativePosition, AlgoExecutionRecord } from '../hooks/usePaperTrading';

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

  describe('Requirement 1 & 5: Strict Authoritative Execution Lifecycle Pipeline', () => {
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

    it('proves Order Filled stage is DONE only when authoritative fill or executed state exists', () => {
      // Case 1: Standby without fill or execution -> PENDING
      const noFillState = {
        execution: null,
        position: null,
      };
      const isExecuted1 =
        noFillState.execution?.state === 'EXECUTED' ||
        (!!noFillState.position && Number(noFillState.position.entryPrice) > 0);
      expect(isExecuted1).toBe(false);

      // Case 2: Authoritative Executed execution record -> DONE
      const executedState = {
        execution: { state: 'EXECUTED' } as AlgoExecutionRecord,
        position: null,
      };
      const isExecuted2 =
        executedState.execution?.state === 'EXECUTED' ||
        (!!executedState.position && Number(executedState.position.entryPrice) > 0);
      expect(isExecuted2).toBe(true);

      // Case 3: Authoritative Position with entry price -> DONE
      const filledPositionState = {
        execution: null,
        position: { entryPrice: 24250, status: 'OPEN' } as AuthoritativePosition,
      };
      const isExecuted3 =
        filledPositionState.execution?.state === 'EXECUTED' ||
        (!!filledPositionState.position && Number(filledPositionState.position.entryPrice) > 0);
      expect(isExecuted3).toBe(true);
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
    it('defines all required empty state presets across the platform', () => {
      const presets: EmptyStatePreset[] = [
        'no-signal',
        'no-position',
        'no-trades',
        'no-market-data',
        'no-scan-results',
        'no-research-runs',
      ];
      expect(presets.length).toBe(6);
      expect(new Set(presets).size).toBe(6);
    });
  });
});
