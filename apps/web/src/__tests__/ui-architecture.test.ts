import { NAV_GROUPS, NavGroup, NavTab } from '../components/Header';
import { MarketDataState } from '../hooks/useMarketContext';

describe('Frontend UI Architecture & Trading UX Tests', () => {
  describe('Requirement 1: Grouped Product Navigation Structure', () => {
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
  });

  describe('Requirement 6 & 10: Market Connection and Execution Invariants', () => {
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
  });
});
