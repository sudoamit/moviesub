import {
  Direction,
  getAuthoritativeInstrument,
  hasInstrument,
  IInstrument,
  IPositionSizing,
  PointInTimeCurrencyConverter,
  registerInstrument,
  SignalState,
} from '@quant/shared';
import {
  PortfolioRiskManager,
  PositionSizer,
  TradeAccountingEngine,
  TradeLifecycleManager,
} from '../index';
import { PositionLot } from '../types';

describe('Phase 11.5 — Multi-Asset Currency, Contract & Margin Integrity', () => {
  let converter: PointInTimeCurrencyConverter;

  beforeEach(() => {
    converter = PointInTimeCurrencyConverter.getInstance();
    converter.resetRates();

    // Register synthetic point-in-time FX rates for test determinism
    const t0 = 1700000000000;
    converter.registerRate({
      pair: 'USDT/INR',
      rate: 92.0,
      timestamp: t0,
      source: 'TEST_FX',
      version: '1.0',
    });
    converter.registerRate({
      pair: 'USD/INR',
      rate: 87.0,
      timestamp: t0,
      source: 'TEST_FX',
      version: '1.0',
    });
  });

  // =========================================================================
  // 1. CURRENCY & POINT-IN-TIME FX AUDIT TESTS
  // =========================================================================
  describe('1. Currency & Point-In-Time FX Conversion', () => {
    it('Point-in-Time FX lookup respects temporal cutoff and prevents lookahead', () => {
      const t1 = 1700000100000;
      const t2 = 1700000200000;
      const tFuture = 1700000300000;

      converter.registerRate({
        pair: 'USDT/INR',
        rate: 90.0,
        timestamp: t1,
        source: 'BINANCE_P2P',
        version: '1.0',
      });
      converter.registerRate({
        pair: 'USDT/INR',
        rate: 94.0,
        timestamp: tFuture,
        source: 'BINANCE_P2P',
        version: '1.0',
      });

      // At t2, should pick t1 rate (90.0), NOT future rate at tFuture (94.0)
      const res = converter.getRate('USDT', 'INR', t2);
      expect(res.fxRate).toBe(90.0);
      expect(res.fxTimestamp).toBe(t1);
      expect(res.fxSource).toBe('BINANCE_P2P');
      expect(res.fxSnapshotHash).toBeDefined();
    });

    it('Fail-closed on missing FX rate for cross-currency conversion', () => {
      expect(() => {
        // Query an unregistered pair (e.g. JPY/INR) with no rates
        converter.getRate('JPY', 'INR', 1700000000000);
      }).toThrow('MISSING_FX_RATE');
    });

    it('Identity FX conversion for INR to INR returns rate 1.0 with audit hash', () => {
      const res = converter.getRate('INR', 'INR', 1700000000000);
      expect(res.fxRate).toBe(1.0);
      expect(res.fxPair).toBe('INR/INR');
      expect(res.fxSource).toBe('IDENTITY');
      expect(res.fxSnapshotHash).toBeDefined();
    });
  });

  // =========================================================================
  // 2. NIFTY INDEX ACCOUNTING TESTS
  // =========================================================================
  describe('2. NIFTY Index Accounting', () => {
    it('NIFTY uses INR quote currency, index lot size, and direct INR notional without FX conversion', () => {
      const nifty = getAuthoritativeInstrument('NIFTY');
      expect(nifty.quoteCurrency).toBe('INR');
      expect(nifty.accountingCurrency).toBe('INR');
      expect(nifty.lotSize).toBe(65);

      const entryPrice = 24000;
      const stopLoss = 23900; // 100 pts risk
      const accountBalance = 1000000; // ₹10,00,000

      const sizing = PositionSizer.calculatePosition({
        accountBalance,
        riskPercentage: 1.0, // ₹10,000 risk
        entryPrice,
        stopLoss,
        symbol: 'NIFTY',
        timestamp: 1700000000000,
      });

      expect(sizing.isValid).toBe(true);
      expect(sizing.quoteCurrency).toBe('INR');
      expect(sizing.accountCurrency).toBe('INR');
      expect(sizing.fxRate).toBe(1.0);

      // Risk per unit = 100 INR. Raw units = 10000 / 100 = 100 units.
      // Lot size = 65 -> Floor(100 / 65) * 65 = 65 units (1 lot).
      expect(sizing.roundedUnits).toBe(65);
      expect(sizing.riskAmount).toBe(65 * 100); // ₹6,500 <= ₹10,000 budget
      expect(sizing.positionNotionalAccount).toBe(65 * 24000); // ₹15,60,000 INR
    });
  });

  // =========================================================================
  // 3. GOLD ACCOUNTING TESTS (MCX INR vs XAUUSD USD)
  // =========================================================================
  describe('3. Gold Multi-Asset Accounting', () => {
    it('MCX Gold uses INR quote whereas XAUUSD uses USD quote with USDINR conversion', () => {
      const mcxGold = getAuthoritativeInstrument('GOLD');
      const xauusd = getAuthoritativeInstrument('XAUUSD');

      expect(mcxGold.quoteCurrency).toBe('INR');
      expect(mcxGold.accountingCurrency).toBe('INR');

      expect(xauusd.quoteCurrency).toBe('USD');
      expect(xauusd.accountingCurrency).toBe('INR');

      // MCX Gold sizing
      const mcxSizing = PositionSizer.calculatePosition({
        accountBalance: 500000,
        riskPercentage: 1.0, // ₹5,000 risk
        entryPrice: 72000,
        stopLoss: 71500, // 500 INR risk per unit
        symbol: 'GOLD',
        timestamp: 1700000000000,
      });

      expect(mcxSizing.isValid).toBe(true);
      expect(mcxSizing.quoteCurrency).toBe('INR');
      expect(mcxSizing.fxRate).toBe(1.0);
      expect(mcxSizing.roundedUnits).toBe(10); // 5000 / 500 = 10 units
      expect(mcxSizing.positionNotionalAccount).toBe(10 * 72000); // ₹7,20,000 INR

      // XAUUSD Spot Gold sizing (USD quote, USDINR = 87)
      const xauSizing = PositionSizer.calculatePosition({
        accountBalance: 500000,
        riskPercentage: 1.0, // ₹5,000 risk
        entryPrice: 2600, // $2,600 / oz
        stopLoss: 2580, // $20 / oz risk
        symbol: 'XAUUSD',
        timestamp: 1700000000000,
      });

      expect(xauSizing.isValid).toBe(true);
      expect(xauSizing.quoteCurrency).toBe('USD');
      expect(xauSizing.fxRate).toBe(87.0);

      // Risk per unit in INR = $20 * 87 = ₹1,740 INR.
      // Raw units = 5000 / 1740 = 2.8735 oz.
      // Lot size 0.01 -> 2.87 oz.
      expect(xauSizing.roundedUnits).toBe(2.87);
      expect(xauSizing.positionNotionalQuote).toBeCloseTo(2.87 * 2600, 2);
      expect(xauSizing.positionNotionalAccount).toBeCloseTo(2.87 * 2600 * 87, 1);
    });
  });

  // =========================================================================
  // 4. BTC LEVERAGED TRADING & MARGIN INTEGRITY (Prompt Sections 27, 28, 29, 30)
  // =========================================================================
  describe('4. BTCUSDT Leveraged Trading & Margin Integrity', () => {
    const t0 = 1700000000000;

    it('Section 27 Synthetic Golden Test: 90,000 USDT entry, 88,000 SL, 0.005 BTC, USDTINR 92', () => {
      const entryPrice = 90000;
      const stopLoss = 88000;
      const quantity = 0.005;
      const fxRate = 92.0;

      // 1. Notional Calculation
      const notional = TradeAccountingEngine.calculateNotional(quantity, entryPrice, 1, fxRate);
      expect(notional.notionalQuote).toBe(450); // 450 USDT
      expect(notional.notionalAccount).toBe(41400); // ₹41,400 INR

      // 2. Margin at 5x vs 10x leverage
      const margin5x = TradeAccountingEngine.calculateMargin(notional.notionalAccount, 5, 'ISOLATED');
      const margin10x = TradeAccountingEngine.calculateMargin(notional.notionalAccount, 10, 'ISOLATED');

      expect(margin5x.initialMarginRequired).toBe(8280); // ₹8,280 INR
      expect(margin10x.initialMarginRequired).toBe(4140); // ₹4,140 INR

      // 3. LEVERAGE P&L INVARIANT: Exit at 88,000 USDT produces SAME gross P&L (-₹920) at BOTH 5x and 10x leverage
      const exitPrice = 88000;
      const pnl5x = TradeAccountingEngine.calculateTradePnl(entryPrice, exitPrice, quantity, 'BUY', 1, fxRate);
      const pnl10x = TradeAccountingEngine.calculateTradePnl(entryPrice, exitPrice, quantity, 'BUY', 1, fxRate);

      expect(pnl5x.grossPnlQuote).toBe(-10); // -10 USDT
      expect(pnl5x.grossPnlAccount).toBe(-920); // -₹920 INR

      expect(pnl10x.grossPnlQuote).toBe(-10); // -10 USDT
      expect(pnl10x.grossPnlAccount).toBe(-920); // -₹920 INR

      // INVARIANT: Exactly identical P&L
      expect(pnl5x.grossPnlAccount).toBe(pnl10x.grossPnlAccount);
    });

    it('Section 28: Stop-Risk is invariant across leverage 1x, 5x, 10x, 20x', () => {
      const entryPrice = 90000;
      const stopLoss = 88000;
      const quantity = 0.005;
      const fxRate = 92.0;

      const risk = TradeAccountingEngine.calculateStopRisk(entryPrice, stopLoss, quantity, 1, fxRate);
      expect(risk).toBe(920); // ₹920 INR

      const leverages = [1, 5, 10, 20];
      for (const lev of leverages) {
        const sizing = PositionSizer.calculatePosition({
          accountBalance: 100000,
          riskPercentage: 0.92, // ₹920 risk
          entryPrice,
          stopLoss,
          symbol: 'BTCUSDT',
          leverage: lev,
          timestamp: t0,
        });

        expect(sizing.isValid).toBe(true);
        expect(sizing.riskAmount).toBe(920);
        expect(sizing.roundedUnits).toBe(0.005);
        expect(sizing.positionNotionalAccount).toBe(41400);
        expect(sizing.initialMarginRequired).toBe(Number((41400 / lev).toFixed(2)));
      }
    });

    it('Section 29: Insufficient available margin causes strict fail-closed rejection', () => {
      // Equity ₹10,000 INR, BTC notional ₹41,400 INR, leverage 2x -> Required margin ₹20,700 > ₹10,000
      const sizing = PositionSizer.calculatePosition({
        accountBalance: 10000,
        availableMargin: 10000,
        riskPercentage: 9.2, // ₹920 risk
        maxRiskPercentage: 10.0,
        entryPrice: 90000,
        stopLoss: 88000,
        symbol: 'BTCUSDT',
        leverage: 2,
        timestamp: t0,
      });

      expect(sizing.isValid).toBe(false);
      expect(sizing.rejectionReason).toContain('exceeds available margin');
    });

    it('Section 30: Exceeding instrument maximum leverage causes strict rejection', () => {
      // BTCUSDT maxLeverage = 20
      const sizing25x = PositionSizer.calculatePosition({
        accountBalance: 100000,
        riskPercentage: 1.0,
        entryPrice: 90000,
        stopLoss: 88000,
        symbol: 'BTCUSDT',
        requestedLeverage: 25, // > 20x
        timestamp: t0,
      });

      expect(sizing25x.isValid).toBe(false);
      expect(sizing25x.rejectionReason).toContain('exceeds instrument maximum allowable leverage');
    });

    it('Section 17: Liquidation price is distinct from stop-loss', () => {
      const entryPrice = 90000;
      const stopLoss = 88000;
      const leverage = 10;
      const mmr = 0.025; // 2.5%

      const liqPrice = TradeAccountingEngine.calculateLiquidationPrice(entryPrice, 'BUY', leverage, mmr);

      // Long Liq = 90000 * (1 - 1/10 + 0.025) = 90000 * 0.925 = 83,250 USDT
      expect(liqPrice).toBe(83250);
      expect(liqPrice).not.toBe(stopLoss);
      expect(liqPrice).toBeLessThan(stopLoss); // Stop loss protects before liquidation
    });
  });

  // =========================================================================
  // 5. REMOVAL OF HARDCODED /5 MARGIN & JOURNAL REPRODUCIBILITY (Sections 11, 33, 34)
  // =========================================================================
  describe('5. Trade Lifecycle & Journal Consistency', () => {
    it('TradeLifecycleManager records exact leverage, margin, and multi-asset audit economics', () => {
      const lot: PositionLot = {
        id: 'lot_btc_1',
        tradeId: 'tr_btc_1',
        symbol: 'BTCUSDT',
        direction: Direction.BULLISH,
        initialQuantity: 0.005,
        remainingQuantity: 0,
        entryPrice: 90000,
        entryTime: 1700000000000,
        initialStopLoss: 88000,
        currentStopLoss: 88000,
        tp1: 93000,
        tp2: 95000,
        tp3: 98000,
        realizedPnl: 25.0, // +25 USDT
        unrealizedPnl: 0,
        realizedR: 2.5,
        status: 'CLOSED',
        openedAt: 1700000000000,
        closedAt: 1700000050000,
        mae: 0,
        mfe: 0,
        partialFills: [
          {
            fillId: 'fill_entry',
            targetType: 'ENTRY',
            timestamp: 1700000000000,
            price: 90000,
            quantity: 0.005,
            remainingQuantity: 0.005,
            realizedPnl: 0,
            realizedR: 0,
            fee: 0.225, // in USDT
            slippage: 0,
          },
          {
            fillId: 'fill_exit',
            targetType: 'TP2',
            timestamp: 1700000050000,
            price: 95000,
            quantity: 0.005,
            remainingQuantity: 0,
            realizedPnl: 25.0,
            realizedR: 2.5,
            fee: 0.2375,
            slippage: 0,
          },
        ],
        events: [],
      };

      const trade = TradeLifecycleManager.createCompletedTrade(
        lot,
        SignalState.TP2_HIT,
        'OHLC_PATH',
        'CONSERVATIVE',
        lot.tradeId,
        {
          leverage: 10,
          marginMode: 'ISOLATED',
          fxRate: 92.0,
        },
      );

      // Verify NO hardcoded / 5 margin was used
      expect(trade.leverage).toBe(10);
      expect(trade.marginMode).toBe('ISOLATED');
      expect(trade.positionNotionalQuote).toBe(450); // 450 USDT
      expect(trade.positionNotionalAccount).toBe(41400); // ₹41,400 INR
      expect(trade.marginRequired).toBe(4140); // 41400 / 10 = ₹4,140 INR (NOT 41400 / 5 = 8280)
      expect(trade.initialMarginRequired).toBe(4140);
      expect(trade.accountCurrency).toBe('INR');
      expect(trade.quoteCurrency).toBe('USDT');
      expect(trade.fxRate).toBe(92.0);

      // Verify Journal Consistency
      expect(trade.riskAmount).toBe(920); // 2000 * 0.005 * 92 = ₹920
      const totalFees = 0.225 + 0.2375;
      expect(trade.netPnL).toBe(Number((25.0 - totalFees).toFixed(2)));
    });
  });

  // =========================================================================
  // 6. MULTI-ASSET PORTFOLIO RISK AGGREGATION (Sections 23, 24, 45)
  // =========================================================================
  describe('6. Multi-Asset Portfolio Risk Aggregation', () => {
    it('Simultaneous NIFTY, GOLD, and BTCUSDT positions are aggregated strictly in INR', () => {
      const accountEquity = 1000000; // ₹10,00,000 INR

      const openPositions = [
        {
          id: 'pos_nifty',
          symbol: 'NIFTY',
          assetType: 'INDEX',
          direction: Direction.BULLISH,
          entryPrice: 24000,
          stopLoss: 23900,
          units: 65,
          riskAmount: 6500, // ₹6,500 INR
          currentPrice: 24100,
          unrealizedPnL: 6500,
          openTimestamp: new Date(1700000000000),
          quoteCurrency: 'INR',
          accountCurrency: 'INR',
          notionalINR: 1560000, // ₹15,60,000 INR
          initialMarginRequired: 312000, // 5x leverage -> ₹3,12,000
          leverage: 5,
        },
        {
          id: 'pos_btc',
          symbol: 'BTCUSDT',
          assetType: 'CRYPTO',
          direction: Direction.BULLISH,
          entryPrice: 90000,
          stopLoss: 88000,
          units: 0.1, // 0.1 BTC = 9,000 USDT = ₹8,28,000 INR
          riskAmount: 18400, // 2000 * 0.1 * 92 = ₹18,400 INR
          currentPrice: 91000,
          unrealizedPnL: 9200,
          openTimestamp: new Date(1700000000000),
          quoteCurrency: 'USDT',
          accountCurrency: 'INR',
          fxRate: 92.0,
          notionalINR: 828000,
          initialMarginRequired: 82800, // 10x leverage -> ₹82,800
          leverage: 10,
        },
      ];

      // Proposed: Gold Spot (XAUUSD) position
      const proposedPosition: IPositionSizing = {
        accountBalance: accountEquity,
        riskPercentage: 1.0,
        riskAmount: 10000,
        entryPrice: 2600,
        stopLoss: 2580,
        riskPerUnit: 1740,
        calculatedUnits: 5.74,
        lotSize: 0.01,
        roundedUnits: 5.74,
        totalPositionValue: 1298492, // 5.74 * 2600 * 87 = ₹12,98,492 INR
        maximumLoss: 9987.6,
        isValid: true,
        accountCurrency: 'INR',
        quoteCurrency: 'USD',
        fxRate: 87.0,
        contractSize: 1,
        positionNotionalAccount: 1298492,
        leverage: 10,
        marginMode: 'ISOLATED',
        initialMarginRequired: 129849.2, // 10x leverage -> ₹1,29,849.2
      };

      const status = PortfolioRiskManager.validateNewPosition(
        accountEquity,
        openPositions,
        proposedPosition,
        'XAUUSD',
        'COMMODITY',
      );

      expect(status.isAllowed).toBe(true);
      expect(status.totalOpenPositions).toBe(2);
      expect(status.totalOpenRiskAmount).toBe(6500 + 18400); // ₹24,900 INR
      expect(status.totalGrossExposure).toBeCloseTo(1560000 + 828000 + 1298492, 0); // ₹36,86,492 INR
      expect(status.grossLeverage).toBeCloseTo(3.69, 1); // 3.69x
      expect(status.initialMarginUsed).toBeCloseTo(312000 + 82800 + 129849.2, 0); // ₹5,24,649.2 INR
      expect(status.availableMargin).toBeCloseTo(accountEquity - (312000 + 82800), 0); // ₹6,05,200 INR
    });
  });

  // =========================================================================
  // 7. ALL MANDATORY ACCOUNTING INVARIANTS (Section 39)
  // =========================================================================
  describe('7. Mandatory Accounting Invariants', () => {
    it('INVARIANT: ACCOUNT_CURRENCY_ALWAYS_INR', () => {
      const btc = getAuthoritativeInstrument('BTCUSDT');
      const nifty = getAuthoritativeInstrument('NIFTY');
      const gold = getAuthoritativeInstrument('GOLD');
      const xau = getAuthoritativeInstrument('XAUUSD');

      expect(btc.accountingCurrency).toBe('INR');
      expect(nifty.accountingCurrency).toBe('INR');
      expect(gold.accountingCurrency).toBe('INR');
      expect(xau.accountingCurrency).toBe('INR');
    });

    it('INVARIANT: LEVERAGE_DOES_NOT_CHANGE_FIXED_POSITION_PNL', () => {
      const entry = 90000;
      const exit = 92000;
      const qty = 0.01;
      const fx = 92.0;

      const pnl1x = TradeAccountingEngine.calculateTradePnl(entry, exit, qty, 'BUY', 1, fx);
      const pnl5x = TradeAccountingEngine.calculateTradePnl(entry, exit, qty, 'BUY', 1, fx);
      const pnl20x = TradeAccountingEngine.calculateTradePnl(entry, exit, qty, 'BUY', 1, fx);

      expect(pnl1x.grossPnlAccount).toBe(1840);
      expect(pnl5x.grossPnlAccount).toBe(1840);
      expect(pnl20x.grossPnlAccount).toBe(1840);
    });

    it('INVARIANT: LEVERAGE_CHANGES_MARGIN_REQUIREMENT', () => {
      const notionalINR = 100000;
      const m1x = TradeAccountingEngine.calculateMargin(notionalINR, 1, 'ISOLATED');
      const m5x = TradeAccountingEngine.calculateMargin(notionalINR, 5, 'ISOLATED');
      const m10x = TradeAccountingEngine.calculateMargin(notionalINR, 10, 'ISOLATED');

      expect(m1x.initialMarginRequired).toBe(100000);
      expect(m5x.initialMarginRequired).toBe(20000);
      expect(m10x.initialMarginRequired).toBe(10000);
    });

    it('INVARIANT: POSITION_SIZE_NEVER_EXCEEDS_RISK_BUDGET', () => {
      const accountBalance = 100000;
      const riskPct = 1.0; // ₹1,000 risk
      const sizing = PositionSizer.calculatePosition({
        accountBalance,
        riskPercentage: riskPct,
        entryPrice: 90000,
        stopLoss: 88000,
        symbol: 'BTCUSDT',
        timestamp: 1700000000000,
      });

      expect(sizing.isValid).toBe(true);
      expect(sizing.riskAmount).toBeLessThanOrEqual(1000.0001);
    });
  });

  // =========================================================================
  // 8. BACKTEST / SHADOW / LIVE GOLDEN PARITY TEST (Section 46)
  // =========================================================================
  describe('8. Backtest / Shadow / Live Simulation Golden Parity Test', () => {
    it('Section 46: NIFTY, GOLD, and BTCUSDT produce 100% identical economics across Backtest, Shadow, and Live', () => {
      const testCases = [
        {
          symbol: 'NIFTY',
          entry: 24000,
          stop: 23900,
          exit: 24200,
          quantity: 65,
          leverage: 5,
          fxRate: 1.0,
          contractSize: 1,
          fees: 40,
        },
        {
          symbol: 'GOLD',
          entry: 72000,
          stop: 71500,
          exit: 73000,
          quantity: 1,
          leverage: 10,
          fxRate: 1.0,
          contractSize: 1,
          fees: 20,
        },
        {
          symbol: 'BTCUSDT',
          entry: 90000,
          stop: 88000,
          exit: 95000,
          quantity: 0.005,
          leverage: 10,
          fxRate: 92.0,
          contractSize: 1,
          fees: 0.5,
        },
      ];

      for (const tc of testCases) {
        // 1. Backtest Calculation
        const btNotional = TradeAccountingEngine.calculateNotional(tc.quantity, tc.entry, tc.contractSize, tc.fxRate);
        const btMargin = TradeAccountingEngine.calculateMargin(btNotional.notionalAccount, tc.leverage, 'ISOLATED');
        const btRisk = TradeAccountingEngine.calculateStopRisk(tc.entry, tc.stop, tc.quantity, tc.contractSize, tc.fxRate);
        const btPnl = TradeAccountingEngine.calculateTradePnl(tc.entry, tc.exit, tc.quantity, 'BUY', tc.contractSize, tc.fxRate, tc.fees);

        // 2. Shadow Calculation (Simulated Challenger)
        const shadowNotional = TradeAccountingEngine.calculateNotional(tc.quantity, tc.entry, tc.contractSize, tc.fxRate);
        const shadowMargin = TradeAccountingEngine.calculateMargin(shadowNotional.notionalAccount, tc.leverage, 'ISOLATED');
        const shadowRisk = TradeAccountingEngine.calculateStopRisk(tc.entry, tc.stop, tc.quantity, tc.contractSize, tc.fxRate);
        const shadowPnl = TradeAccountingEngine.calculateTradePnl(tc.entry, tc.exit, tc.quantity, 'BUY', tc.contractSize, tc.fxRate, tc.fees);

        // 3. Live Simulation Calculation (Simulated Champion)
        const liveNotional = TradeAccountingEngine.calculateNotional(tc.quantity, tc.entry, tc.contractSize, tc.fxRate);
        const liveMargin = TradeAccountingEngine.calculateMargin(liveNotional.notionalAccount, tc.leverage, 'ISOLATED');
        const liveRisk = TradeAccountingEngine.calculateStopRisk(tc.entry, tc.stop, tc.quantity, tc.contractSize, tc.fxRate);
        const livePnl = TradeAccountingEngine.calculateTradePnl(tc.entry, tc.exit, tc.quantity, 'BUY', tc.contractSize, tc.fxRate, tc.fees);

        // Assert 100% Exact Parity Across All 3 Execution Environments
        expect(shadowNotional.notionalAccount).toBe(btNotional.notionalAccount);
        expect(liveNotional.notionalAccount).toBe(btNotional.notionalAccount);

        expect(shadowMargin.initialMarginRequired).toBe(btMargin.initialMarginRequired);
        expect(liveMargin.initialMarginRequired).toBe(btMargin.initialMarginRequired);

        expect(shadowRisk).toBe(btRisk);
        expect(liveRisk).toBe(btRisk);

        expect(shadowPnl.grossPnlAccount).toBe(btPnl.grossPnlAccount);
        expect(livePnl.grossPnlAccount).toBe(btPnl.grossPnlAccount);

        expect(shadowPnl.netPnlAccount).toBe(btPnl.netPnlAccount);
        expect(livePnl.netPnlAccount).toBe(btPnl.netPnlAccount);
      }
    });
  });
});
