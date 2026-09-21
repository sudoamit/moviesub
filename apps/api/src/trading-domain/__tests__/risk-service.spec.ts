import { RiskService } from '../risk.service';
import { PositionState, OrderState } from '@quant/shared';

describe('Phase 5 — Risk Engine Domain Suite', () => {
  let service: RiskService;

  let mockTrades: any[] = [];
  let mockPositions: any[] = [];
  let mockOrders: any[] = [];
  let mockAccount: any = {
    id: 'acc_risk_01',
    initialCapital: 1000000,
    cashBalance: 1000000,
    usedMargin: 0,
  };
  let mockConfig: any = {
    id: 'SYSTEM_DEFAULT',
    emergencyStop: false,
    maxOpenPositions: 5,
    maxTradesPerDay: 20,
    maxConsecutiveLosses: 3,
    maxPositionRiskPercent: 1.0,
    maxDailyLossPercent: 3.0,
    maxTotalExposurePercent: 200.0, // 200% notional exposure cap
  };

  const mockPrisma: any = {
    paperAccount: {
      findUnique: jest.fn(() => mockAccount),
    },
    tradingSystemConfig: {
      findUnique: jest.fn(() => mockConfig),
    },
    paperPosition: {
      findMany: jest.fn(() => mockPositions),
      count: jest.fn(({ where }) => {
        let res = [...mockPositions];
        if (where?.accountId) res = res.filter((p) => p.accountId === where.accountId);
        if (where?.status?.in) res = res.filter((p) => where.status.in.includes(p.status));
        return res.length;
      }),
    },
    paperOrder: {
      count: jest.fn(({ where }) => {
        let res = [...mockOrders];
        if (where?.accountId) res = res.filter((o) => o.accountId === where.accountId);
        if (where?.createdAt?.gte) res = res.filter((o) => o.createdAt >= where.createdAt.gte);
        return res.length;
      }),
    },
    paperTrade: {
      findMany: jest.fn(({ where, orderBy, take }) => {
        let res = [...mockTrades];
        if (where?.accountId) res = res.filter((t) => t.accountId === where.accountId);
        if (where?.exitTime?.gte) res = res.filter((t) => t.exitTime >= where.exitTime.gte);
        if (orderBy?.exitTime === 'desc') res.sort((a, b) => b.exitTime.getTime() - a.exitTime.getTime());
        if (take) res = res.slice(0, take);
        return res;
      }),
    },
  };

  beforeAll(() => {
    service = new RiskService(mockPrisma);
  });

  beforeEach(() => {
    mockTrades = [];
    mockPositions = [];
    mockOrders = [];
    mockAccount = {
      id: 'acc_risk_01',
      initialCapital: 1000000,
      cashBalance: 1000000,
      usedMargin: 0,
    };
    mockConfig = {
      id: 'SYSTEM_DEFAULT',
      emergencyStop: false,
      maxOpenPositions: 5,
      maxTradesPerDay: 20,
      maxConsecutiveLosses: 3,
      maxPositionRiskPercent: 1.0,
      maxDailyLossPercent: 3.0,
      maxTotalExposurePercent: 200.0,
    };
  });

  describe('1. Strict Separation of Notional Exposure, Margin, and Risk', () => {
    it('proves Notional Exposure != Margin != Risk for leveraged instrument', () => {
      // Leveraged instrument: Entry 100, Stop 95, Qty 10, Leverage 10, ContractSize 1, FX 1
      const calc = service.calculateTradeRisk({
        entryPrice: 100,
        stopLoss: 95,
        quantity: 10,
        contractSize: 1,
        fxRate: 1.0,
        leverage: 10,
        marginMode: 'ISOLATED',
        accountEquity: 100000,
      });

      // 1. Notional = 100 * 10 = 1000
      expect(calc.tradeNotional).toBe(1000);

      // 2. Margin = 1000 / 10 = 100
      expect(calc.marginRequired).toBe(100);

      // 3. Risk = (100 - 95) * 10 = 50
      expect(calc.tradeRiskAmount).toBe(50);
      expect(calc.tradeRiskPercent).toBe(0.05); // 50 / 100000 * 100

      // Invariant: Never substitute one for another
      expect(calc.tradeNotional).not.toBe(calc.marginRequired);
      expect(calc.tradeNotional).not.toBe(calc.tradeRiskAmount);
      expect(calc.marginRequired).not.toBe(calc.tradeRiskAmount);
    });

    it('proves Notional Exposure != Risk for Spot instrument', () => {
      // Spot: Entry 50000, Stop 49000, Qty 0.1, Leverage 1, Spot Margin
      const calc = service.calculateTradeRisk({
        entryPrice: 50000,
        stopLoss: 49000,
        quantity: 0.1,
        contractSize: 1,
        fxRate: 90.0,
        leverage: 1,
        marginMode: 'SPOT',
        accountEquity: 1000000,
      });

      // Notional = 0.1 * 50000 * 90 = 450,000 INR
      expect(calc.tradeNotional).toBe(450000);
      // Margin = 450,000 INR (Spot is 100% margin)
      expect(calc.marginRequired).toBe(450000);
      // Risk = 0.1 * (50000 - 49000) * 90 = 9,000 INR
      expect(calc.tradeRiskAmount).toBe(9000);
      expect(calc.tradeRiskPercent).toBe(0.9); // 9000 / 1000000 * 100

      expect(calc.tradeNotional).not.toBe(calc.tradeRiskAmount);
    });
  });

  describe('2. Loss Semantics: Losses, Breakevens, and Wins', () => {
    it('counts PnL < 0 as LOSS and ignores PnL = 0 (BREAKEVEN) in consecutive losses', async () => {
      // 3 consecutive losses with a breakeven in between: [-100, 0, -50, -20]
      const now = Date.now();
      mockTrades = [
        { accountId: 'acc_risk_01', realizedPnL: -100, exitTime: new Date(now - 1000) },
        { accountId: 'acc_risk_01', realizedPnL: 0, exitTime: new Date(now - 2000) }, // BREAKEVEN
        { accountId: 'acc_risk_01', realizedPnL: -50, exitTime: new Date(now - 3000) },
        { accountId: 'acc_risk_01', realizedPnL: -20, exitTime: new Date(now - 4000) },
      ];

      const check = await service.checkMaxConsecutiveLosses('acc_risk_01', 3, false);
      // Streak of losses is 3 because breakeven was not counted as a loss and did not reset
      expect(check.allowed).toBe(false);
      expect(check.reasonCode).toBe('MAX_CONSECUTIVE_LOSSES');
    });

    it('resets consecutive losses streak when a WIN (PnL > 0) occurs', async () => {
      // Recent trades: [-100, 50, -50, -20]
      const now = Date.now();
      mockTrades = [
        { accountId: 'acc_risk_01', realizedPnL: -100, exitTime: new Date(now - 1000) },
        { accountId: 'acc_risk_01', realizedPnL: 50, exitTime: new Date(now - 2000) }, // WIN resets streak
        { accountId: 'acc_risk_01', realizedPnL: -50, exitTime: new Date(now - 3000) },
        { accountId: 'acc_risk_01', realizedPnL: -20, exitTime: new Date(now - 4000) },
      ];

      const check = await service.checkMaxConsecutiveLosses('acc_risk_01', 3, false);
      expect(check.allowed).toBe(true);
      expect(check.currentValue).toBe(1);
    });
  });

  describe('3. Explicit Risk-Day Timezone Calculations', () => {
    it('calculates exact start-of-day in Asia/Kolkata timezone (UTC+5:30)', () => {
      // Reference time: 2026-09-20 08:00:00 UTC (which is 13:30 IST on Sept 20)
      const refTime = new Date('2026-09-20T08:00:00.000Z');
      const startIST = service.getStartOfDay('Asia/Kolkata', refTime);

      // Start of day in IST for Sept 20 is 2026-09-19T18:30:00.000Z
      expect(startIST.toISOString()).toBe('2026-09-19T18:30:00.000Z');
    });

    it('calculates exact start-of-day in UTC timezone', () => {
      const refTime = new Date('2026-09-20T08:00:00.000Z');
      const startUTC = service.getStartOfDay('UTC', refTime);

      expect(startUTC.toISOString()).toBe('2026-09-20T00:00:00.000Z');
    });

    it('evaluates daily loss limit strictly within explicit risk timezone', async () => {
      // Trade exited before IST midnight (e.g. yesterday IST) should not count against today
      const yesterdayIST = new Date('2026-09-19T17:00:00.000Z'); // 22:30 IST on Sept 19
      const todayIST = new Date('2026-09-19T19:00:00.000Z'); // 00:30 IST on Sept 20

      mockTrades = [
        { accountId: 'acc_risk_01', realizedPnL: -50000, exitTime: yesterdayIST }, // yesterday: -50,000
        { accountId: 'acc_risk_01', realizedPnL: -10000, exitTime: todayIST }, // today: -10,000
      ];

      // Capital = 1,000,000, Max daily loss = 3% = 30,000 INR
      // In Asia/Kolkata, today's loss is only -10,000 (allowed!)
      const check = await service.checkMaxDailyLoss('acc_risk_01', 3.0, 1000000, 'Asia/Kolkata', todayIST);
      expect(check.allowed).toBe(true);
      expect(check.currentValue).toBe(-10000);
    });
  });

  describe('4. Governance Limits: Exposure, Margin, Risk', () => {
    it('rejects when trade risk exceeds maxRiskPerTrade', () => {
      // 1% of 1,000,000 = 10,000
      const pass = service.checkMaxRiskPerTrade(8000, 10000);
      expect(pass.allowed).toBe(true);

      const reject = service.checkMaxRiskPerTrade(12000, 10000);
      expect(reject.allowed).toBe(false);
      expect(reject.reasonCode).toBe('MAX_RISK_PER_TRADE');
    });

    it('rejects when total notional exposure exceeds maxTotalExposure', () => {
      // Limit 2,000,000
      const pass = service.checkMaxTotalExposure(1500000, 2000000);
      expect(pass.allowed).toBe(true);

      const reject = service.checkMaxTotalExposure(2500000, 2000000);
      expect(reject.allowed).toBe(false);
      expect(reject.reasonCode).toBe('TOTAL_EXPOSURE_LIMIT');
    });

    it('rejects when used margin exceeds cash balance / maxMarginAllowed', () => {
      const pass = service.checkMaxUsedMargin(800000, 1000000);
      expect(pass.allowed).toBe(true);

      const reject = service.checkMaxUsedMargin(1100000, 1000000);
      expect(reject.allowed).toBe(false);
      expect(reject.reasonCode).toBe('MAX_USED_MARGIN');
    });

    it('halts all orders immediately when emergency stop is active', async () => {
      mockConfig.emergencyStop = true;

      const evalResult = await service.evaluateOrderRisk({
        accountId: 'acc_risk_01',
        symbol: 'BTCUSDT_SPOT',
        instrumentType: 'SPOT',
        orderSide: 'BUY',
        quantity: 0.1,
        entryPrice: 60000,
        requiredMargin: 50000,
        riskAmountAccount: 5000,
      });

      expect(evalResult.allowed).toBe(false);
      expect(evalResult.reasonCode).toBe('EMERGENCY_STOP');
    });
  });
});
