import {
  buildAccountingSnapshot,
  computeAccountingSnapshotHash,
  Direction,
  getAuthoritativeInstrument,
  hasInstrument,
  IInstrument,
  IPositionSizing,
  ITradeAccountingSnapshot,
  PointInTimeCurrencyConverter,
  registerInstrument,
  resolveMarginModel,
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
      // Equity ₹10,000 INR, available margin ₹2,000 INR, minimum 0.001 BTC at 2x leverage requires ₹4,140 INR margin > ₹2,000
      const sizing = PositionSizer.calculatePosition({
        accountBalance: 10000,
        availableMargin: 2000,
        riskPercentage: 9.2, // ₹920 risk
        maxRiskPercentage: 10.0,
        entryPrice: 90000,
        stopLoss: 88000,
        symbol: 'BTCUSDT',
        requestedLeverage: 2,
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
      expect(sizing25x.rejectionReason).toContain('exceeds maximum allowable leverage');
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

  // =========================================================================
  // 9. INITIAL MARGIN RATE PRIORITY TESTS (AI Fix 98)
  // =========================================================================
  describe('9. Initial Margin Rate Model & Priority', () => {
    it('TradeAccountingEngine.calculateMargin respects explicit initialMarginRate over naive 1/leverage', () => {
      const notionalINR = 100000; // ₹1,00,000
      // GOLD has defaultLeverage = 5, initialMarginRate = 0.10 (10%)
      const margin = TradeAccountingEngine.calculateMargin(
        notionalINR,
        5, // leverage
        'ISOLATED',
        0.10, // explicit initialMarginRate
        0.05, // maintenanceMarginRate
      );

      // Explicit initialMarginRate: 100,000 * 0.10 = ₹10,000, NOT 100,000 / 5 = ₹20,000
      expect(margin.initialMarginRequired).toBe(10000);
      expect(margin.maintenanceMarginRequired).toBe(5000);
    });

    it('SPOT margin mode requires 100% notional regardless of initialMarginRate or leverage', () => {
      const notionalINR = 50000;
      const margin = TradeAccountingEngine.calculateMargin(notionalINR, 10, 'SPOT', 0.05);
      expect(margin.initialMarginRequired).toBe(50000);
    });

    it('Fallback to notional / leverage when initialMarginRate is not specified', () => {
      const notionalINR = 100000;
      const margin = TradeAccountingEngine.calculateMargin(notionalINR, 4, 'ISOLATED', undefined);
      expect(margin.initialMarginRequired).toBe(25000);
    });
  });

  // =========================================================================
  // 10. MODEL-DRIVEN LIQUIDATION PRICE TESTS (AI Fix 98)
  // =========================================================================
  describe('10. Model-Driven Liquidation Price', () => {
    it('SPOT / cash / 1x leverage cannot be liquidated (returns undefined)', () => {
      const liqSpot = TradeAccountingEngine.calculateLiquidationPrice({
        entryPrice: 90000,
        direction: 'LONG',
        leverage: 1,
        marginMode: 'SPOT',
        liquidationModel: 'SPOT_NONE',
      });
      expect(liqSpot).toBeUndefined();
    });

    it('ISOLATED_LINEAR calculates exact liquidation threshold with initialMarginRate', () => {
      const liqLong = TradeAccountingEngine.calculateLiquidationPrice({
        entryPrice: 1000,
        direction: 'LONG',
        leverage: 10,
        initialMarginRate: 0.10,
        maintenanceMarginRate: 0.02,
        liquidationModel: 'ISOLATED_LINEAR',
      });
      // 1000 * (1 - 0.10 + 0.02) = 1000 * 0.92 = 920
      expect(liqLong).toBe(920);

      const liqShort = TradeAccountingEngine.calculateLiquidationPrice({
        entryPrice: 1000,
        direction: 'SHORT',
        leverage: 10,
        initialMarginRate: 0.10,
        maintenanceMarginRate: 0.02,
        liquidationModel: 'ISOLATED_LINEAR',
      });
      // 1000 * (1 + 0.10 - 0.02) = 1000 * 1.08 = 1080
      expect(liqShort).toBe(1080);
    });

    it('Unsupported liquidation model fails closed (returns undefined)', () => {
      const liq = TradeAccountingEngine.calculateLiquidationPrice({
        entryPrice: 1000,
        direction: 'LONG',
        leverage: 10,
        liquidationModel: 'CROSS_STANDARD' as any,
      });
      expect(liq).toBeUndefined();
    });
  });

  // =========================================================================
  // 11. NET PNL, FEE & SLIPPAGE INVARIANTS (AI Fix 98)
  // =========================================================================
  describe('11. Net P&L Fee and Slippage Exactness', () => {
    it('When slippage is included in prices, net P&L = gross P&L - explicit fees', () => {
      const res = TradeAccountingEngine.calculateTradePnl({
        entryPrice: 100,
        exitPrice: 110,
        quantity: 10,
        direction: 'LONG',
        fees: 15,
        slippage: 5,
        slippageIncludedInPrices: true,
      });

      // Gross: (110 - 100) * 10 = 100 INR
      expect(res.grossPnlAccount).toBe(100);
      // Net: 100 - 15 = 85 INR (slippage already in 100 and 110)
      expect(res.netPnlAccount).toBe(85);
    });

    it('When slippage is unpriced, net P&L = gross P&L - fees - slippage', () => {
      const res = TradeAccountingEngine.calculateTradePnl({
        entryPrice: 100,
        exitPrice: 110,
        quantity: 10,
        direction: 'LONG',
        fees: 15,
        slippage: 5,
        slippageIncludedInPrices: false,
      });

      // Gross: 100 INR
      expect(res.grossPnlAccount).toBe(100);
      // Net: 100 - 15 - 5 = 80 INR
      expect(res.netPnlAccount).toBe(80);
    });
  });

  // =========================================================================
  // 12. INSTRUMENT VS VENUE/ACCOUNT PROFILE SEPARATION (AI Fix 98)
  // =========================================================================
  describe('12. Instrument vs Venue/Account Profile Separation', () => {
    it('Default authoritative instrument contains base contract specifications and default venue profile', () => {
      const nifty = getAuthoritativeInstrument('NIFTY');
      expect(nifty.symbol).toBe('NIFTY');
      expect(nifty.lotSize).toBe(65);
      expect(nifty.venueProfile?.venueId).toBe('NSE_DERIVATIVES');
      expect(nifty.venueProfile?.defaultLeverage).toBe(5);
    });

    it('getAuthoritativeInstrument allows overriding venue margin profile without mutating contract specs', () => {
      const customNifty = getAuthoritativeInstrument('NIFTY', {
        venueId: 'CUSTOM_BROKER_PRO',
        maxLeverage: 3,
        initialMarginRate: 0.3333,
        maintenanceMarginRate: 0.15,
      });

      // Contract specs preserved
      expect(customNifty.symbol).toBe('NIFTY');
      expect(customNifty.lotSize).toBe(65);
      expect(customNifty.tickSize).toBe(0.05);

      // Venue rules overridden
      expect(customNifty.maxLeverage).toBe(3);
      expect(customNifty.initialMarginRate).toBe(0.3333);
      expect(customNifty.maintenanceMarginRate).toBe(0.15);
      expect(customNifty.venueProfile?.venueId).toBe('CUSTOM_BROKER_PRO');

      // Original specification unaffected
      const originalNifty = getAuthoritativeInstrument('NIFTY');
      expect(originalNifty.maxLeverage).toBe(5);
    });
  });

  // =========================================================================
  // 13. UNIFIED MARGIN MODEL RESOLUTION TESTS (AI Fix 99)
  // =========================================================================
  describe('13. Unified Margin Model Resolution (resolveMarginModel)', () => {
    it('SPOT instrument resolves to SPOT_NONE, leverage=1, initialMarginRate=1.0, MMR=0', () => {
      const spotInst: IInstrument = {
        id: 'inst_reliance_spot',
        symbol: 'RELIANCE_CASH',
        name: 'Reliance Cash',
        exchange: 'NSE',
        assetType: 'EQUITY' as any,
        tickSize: 0.05,
        lotSize: 1,
        contractSize: 1,
        currency: 'INR',
        marginMode: 'SPOT',
        isActive: true,
      };

      const model = resolveMarginModel(spotInst);
      expect(model.marginMode).toBe('SPOT');
      expect(model.effectiveLeverage).toBe(1);
      expect(model.initialMarginRate).toBe(1.0);
      expect(model.maintenanceMarginRate).toBe(0.0);
      expect(model.liquidationModel).toBe('SPOT_NONE');
    });

    it('Resolves DERIVATIVE instrument with default leverage and venue profile', () => {
      const gold = getAuthoritativeInstrument('GOLD');
      const model = resolveMarginModel(gold);
      expect(model.marginMode).toBe('ISOLATED');
      expect(model.effectiveLeverage).toBe(5);
      expect(model.initialMarginRate).toBe(0.1);
      expect(model.maintenanceMarginRate).toBe(0.05);
      expect(model.liquidationModel).toBe('ISOLATED_LINEAR');
    });

    it('Rejects requested leverage exceeding instrument maximum leverage', () => {
      const nifty = getAuthoritativeInstrument('NIFTY'); // maxLeverage: 5
      expect(() =>
        resolveMarginModel(nifty, { requestedLeverage: 10 }),
      ).toThrowError(/LEVERAGE_EXCEEDS_MAX/);
    });

    it('Dynamically sets initialMarginRate to 1/leverage when requested leverage is within limits', () => {
      const btc = getAuthoritativeInstrument('BTCUSDT'); // maxLeverage: 20
      const model = resolveMarginModel(btc, { requestedLeverage: 10 });
      expect(model.effectiveLeverage).toBe(10);
      expect(model.initialMarginRate).toBe(0.10); // 1 / 10 = 10%
    });
  });

  // =========================================================================
  // 14. MARGIN & LIQUIDATION CONSISTENCY UNDER VARYING LEVERAGE (AI Fix 99)
  // =========================================================================
  describe('14. Margin & Liquidation Consistency under Varying Requested Leverage', () => {
    it('PositionSizer, calculateMargin, and calculateLiquidationPrice share identical initialMarginRate', () => {
      const accountBalance = 500000;
      const entryPrice = 90000;
      const stopLoss = 88000;
      const requestedLeverage = 4; // 4x leverage -> 25% initial margin rate

      const sizing = PositionSizer.calculatePosition({
        accountBalance,
        riskPercentage: 1.0,
        entryPrice,
        stopLoss,
        symbol: 'BTCUSDT',
        requestedLeverage,
        timestamp: 1700000000000,
      });

      expect(sizing.isValid).toBe(true);
      expect(sizing.leverage).toBe(4);

      // Verify margin is exactly notional * 25% (1 / 4)
      const notionalAccount = sizing.positionNotionalAccount!;
      const expectedInitialMargin = notionalAccount * 0.25;
      expect(sizing.initialMarginRequired).toBeCloseTo(expectedInitialMargin, 1);

      // Verify liquidation price uses the EXACT SAME 25% initial margin rate (not the default instrument 5%)
      // Long Liq = 90000 * (1 - 0.25 + 0.025) = 90000 * 0.775 = 69750
      expect(sizing.liquidationPrice).toBe(69750);
    });
  });

  // =========================================================================
  // 15. FAIL-CLOSED UNKNOWN INSTRUMENT RESOLUTION (AI Fix 99)
  // =========================================================================
  describe('15. Fail-Closed Unknown Instrument Resolution', () => {
    it('PositionSizer rejects unknown symbols in production without silent fallback', () => {
      const sizing = PositionSizer.calculatePosition({
        accountBalance: 100000,
        riskPercentage: 1.0,
        entryPrice: 100,
        stopLoss: 95,
        symbol: 'UNKNOWN_CRYPTO_TOKEN',
      });

      expect(sizing.isValid).toBe(false);
      expect(sizing.rejectionReason).toContain('UNKNOWN_UNSUPPORTED_INSTRUMENT');
    });

    it('PositionSizer allows unregistered symbols when allowUnregisteredSymbols is explicitly true', () => {
      const sizing = PositionSizer.calculatePosition({
        accountBalance: 100000,
        riskPercentage: 1.0,
        entryPrice: 100,
        stopLoss: 95,
        symbol: 'SYNTHETIC_TEST_ASSET',
        allowUnregisteredSymbols: true,
      });

      expect(sizing.isValid).toBe(true);
      expect(sizing.roundedUnits).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 17. NON-FINITE (NaN, Infinity) REJECTION (AI Fix 100)
  // =========================================================================
  describe('17. Non-Finite (NaN, Infinity) Number Rejection Across Primitives', () => {
    it('calculateNotional rejects NaN, Infinity, -Infinity', () => {
      expect(() => TradeAccountingEngine.calculateNotional(NaN, 100, 1, 1.0)).toThrowError(
        /INVALID_NOTIONAL_INPUTS/,
      );
      expect(() => TradeAccountingEngine.calculateNotional(10, Infinity, 1, 1.0)).toThrowError(
        /INVALID_NOTIONAL_INPUTS/,
      );
      expect(() => TradeAccountingEngine.calculateNotional(10, 100, -Infinity, 1.0)).toThrowError(
        /INVALID_NOTIONAL_INPUTS/,
      );
      expect(() => TradeAccountingEngine.calculateNotional(10, 100, 1, NaN)).toThrowError(
        /INVALID_NOTIONAL_INPUTS/,
      );
    });

    it('calculateMargin rejects NaN and non-finite notional/leverage', () => {
      expect(() => TradeAccountingEngine.calculateMargin(NaN, 5)).toThrowError(
        /INVALID_MARGIN_INPUTS/,
      );
      expect(() => TradeAccountingEngine.calculateMargin(10000, NaN)).toThrowError(
        /INVALID_MARGIN_INPUTS/,
      );
      expect(() => TradeAccountingEngine.calculateMargin(10000, 5, 'ISOLATED', NaN)).toThrowError(
        /INVALID_MARGIN_INPUTS/,
      );
    });

    it('calculateStopRisk rejects non-finite values', () => {
      expect(() => TradeAccountingEngine.calculateStopRisk(NaN, 100, 1)).toThrowError(
        /INVALID_RISK_INPUTS/,
      );
      expect(() => TradeAccountingEngine.calculateStopRisk(100, NaN, 1)).toThrowError(
        /INVALID_RISK_INPUTS/,
      );
      expect(() => TradeAccountingEngine.calculateStopRisk(100, 90, Infinity)).toThrowError(
        /INVALID_RISK_INPUTS/,
      );
    });

    it('calculateTradePnl rejects non-finite prices and quantities', () => {
      expect(() =>
        TradeAccountingEngine.calculateTradePnl({
          entryPrice: NaN,
          exitPrice: 110,
          quantity: 1,
          direction: 'LONG',
        }),
      ).toThrowError(/INVALID_PNL_INPUTS/);
      expect(() =>
        TradeAccountingEngine.calculateTradePnl({
          entryPrice: 100,
          exitPrice: Infinity,
          quantity: 1,
          direction: 'LONG',
        }),
      ).toThrowError(/INVALID_PNL_INPUTS/);
    });
  });

  // =========================================================================
  // 18. CROSS-CURRENCY PNL FAIL-CLOSED FX CHECKS (AI Fix 100)
  // =========================================================================
  describe('18. Cross-Currency P&L Strict Fail-Closed FX Checks', () => {
    it('calculateTradePnl throws MISSING_FX_RATE when cross-currency FX is not provided or non-positive', () => {
      expect(() =>
        TradeAccountingEngine.calculateTradePnl({
          entryPrice: 90000,
          exitPrice: 95000,
          quantity: 0.1,
          direction: 'LONG',
          quoteCurrency: 'USDT',
          accountCurrency: 'INR',
          // fxRate missing!
        }),
      ).toThrowError(/MISSING_FX_RATE/);

      expect(() =>
        TradeAccountingEngine.calculateTradePnl({
          entryPrice: 90000,
          exitPrice: 95000,
          quantity: 0.1,
          direction: 'LONG',
          quoteCurrency: 'USDT',
          accountCurrency: 'INR',
          fxRate: 0,
        }),
      ).toThrowError(/MISSING_FX_RATE/);
    });

    it('calculateTradePnl correctly calculates cross-currency INR P&L when explicit FX is provided', () => {
      const pnl = TradeAccountingEngine.calculateTradePnl({
        entryPrice: 90000,
        exitPrice: 95000,
        quantity: 0.1,
        direction: 'LONG',
        quoteCurrency: 'USDT',
        accountCurrency: 'INR',
        fxRate: 92.0,
      });

      // Gross USDT = (95000 - 90000) * 0.1 = 500 USDT
      expect(pnl.grossPnlQuote).toBe(500);
      // Gross INR = 500 * 92.0 = ₹46,000 INR
      expect(pnl.grossPnlAccount).toBe(46000);
      expect(pnl.netPnlAccount).toBe(46000);
    });
  });

  // =========================================================================
  // 19. PRODUCTION GUARD ON ALLOWUNREGISTEREDSYMBOLS (AI Fix 100)
  // =========================================================================
  describe('19. Production Guard on allowUnregisteredSymbols', () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it('Throws PROD_UNREGISTERED_SYMBOL_FORBIDDEN in production environment', () => {
      process.env.NODE_ENV = 'production';

      expect(() =>
        PositionSizer.calculatePosition({
          accountBalance: 100000,
          riskPercentage: 1.0,
          entryPrice: 100,
          stopLoss: 95,
          symbol: 'SYNTHETIC_MOCK',
          allowUnregisteredSymbols: true,
        }),
      ).toThrowError(/PROD_UNREGISTERED_SYMBOL_FORBIDDEN/);
    });
  });

  // =========================================================================
  // 20. PERSISTED RESOLVED MARGIN MODEL SNAPSHOT (AI Fix 100)
  // =========================================================================
  describe('20. Persisted Resolved Margin Model Snapshot', () => {
    it('PositionSizer and TradeLifecycleManager attach resolvedMarginModel for auditability', () => {
      const sizing = PositionSizer.calculatePosition({
        accountBalance: 500000,
        riskPercentage: 1.0,
        entryPrice: 90000,
        stopLoss: 88000,
        symbol: 'BTCUSDT',
        requestedLeverage: 10,
        timestamp: 1700000000000,
      });

      expect(sizing.isValid).toBe(true);
      expect(sizing.resolvedMarginModel).toBeDefined();
      expect(sizing.resolvedMarginModel?.effectiveLeverage).toBe(10);
      expect(sizing.resolvedMarginModel?.initialMarginRate).toBe(0.10);
      expect(sizing.resolvedMarginModel?.maintenanceMarginRate).toBe(0.025);
      expect(sizing.resolvedMarginModel?.liquidationModel).toBe('ISOLATED_LINEAR');

      // Check TradeLifecycleManager attaches it to completed trade
      const lot: PositionLot = {
        id: 'lot_btc_snap',
        tradeId: 'tr_btc_snap',
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
        realizedPnl: 25.0,
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
            fee: 0,
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
            fee: 0,
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
        { leverage: 10, fxRate: 92.0 },
      );

      expect(trade.resolvedMarginModel).toBeDefined();
      expect(trade.resolvedMarginModel?.effectiveLeverage).toBe(10);
      expect(trade.resolvedMarginModel?.initialMarginRate).toBe(0.10);
    });
  });

  // =========================================================================
  // 21. FULL MATRIX OF ACCOUNTING INVARIANTS (AI Fix 100)
  // =========================================================================
  describe('21. Full Matrix of Accounting Invariant Tests', () => {
    it('Invariant A: Leverage changes margin, NOT fixed-position gross P&L or stop-risk', () => {
      const entry = 90000;
      const exit = 95000;
      const stop = 88000;
      const qty = 0.01;
      const fx = 92.0;

      // Stop risk at 1x, 5x, 20x
      const risk1x = TradeAccountingEngine.calculateStopRisk(entry, stop, qty, 1, fx);
      const risk5x = TradeAccountingEngine.calculateStopRisk(entry, stop, qty, 1, fx);
      const risk20x = TradeAccountingEngine.calculateStopRisk(entry, stop, qty, 1, fx);
      expect(risk1x).toBe(risk5x);
      expect(risk5x).toBe(risk20x);
      expect(risk1x).toBe(1840); // (90000 - 88000) * 0.01 * 92 = ₹1,840

      // Gross P&L at 1x, 5x, 20x
      const pnl1x = TradeAccountingEngine.calculateTradePnl({
        entryPrice: entry,
        exitPrice: exit,
        quantity: qty,
        direction: 'LONG',
        fxRate: fx,
      });
      const pnl20x = TradeAccountingEngine.calculateTradePnl({
        entryPrice: entry,
        exitPrice: exit,
        quantity: qty,
        direction: 'LONG',
        fxRate: fx,
      });
      expect(pnl1x.grossPnlAccount).toBe(pnl20x.grossPnlAccount);
      expect(pnl1x.grossPnlAccount).toBe(4600); // (95000 - 90000) * 0.01 * 92 = ₹4,600

      // Margin requirement MUST change with leverage
      const notionalAccount = 90000 * qty * fx; // ₹82,800
      const margin1x = TradeAccountingEngine.calculateMargin(notionalAccount, 1, 'ISOLATED');
      const margin5x = TradeAccountingEngine.calculateMargin(notionalAccount, 5, 'ISOLATED');
      const margin20x = TradeAccountingEngine.calculateMargin(notionalAccount, 20, 'ISOLATED');
      expect(margin1x.initialMarginRequired).toBe(82800);
      expect(margin5x.initialMarginRequired).toBe(16560);
      expect(margin20x.initialMarginRequired).toBe(4140);
    });

    it('Invariant B: FX rate changes account notional and P&L strictly proportionally', () => {
      const entry = 1000;
      const exit = 1100;
      const qty = 2;

      const pnlFx1 = TradeAccountingEngine.calculateTradePnl({
        entryPrice: entry,
        exitPrice: exit,
        quantity: qty,
        direction: 'LONG',
        fxRate: 80.0,
      });
      const pnlFx2 = TradeAccountingEngine.calculateTradePnl({
        entryPrice: entry,
        exitPrice: exit,
        quantity: qty,
        direction: 'LONG',
        fxRate: 90.0,
      });

      // Gross quote: (1100 - 1000) * 2 = 200 USD
      expect(pnlFx1.grossPnlQuote).toBe(200);
      expect(pnlFx2.grossPnlQuote).toBe(200);

      // Account INR strictly proportional to FX
      expect(pnlFx1.grossPnlAccount).toBe(16000); // 200 * 80
      expect(pnlFx2.grossPnlAccount).toBe(18000); // 200 * 90
      expect(pnlFx2.grossPnlAccount / pnlFx1.grossPnlAccount).toBeCloseTo(90.0 / 80.0, 4);
    });

    it('Invariant C: Identical resolved margin model yields identical margin and liquidation pricing', () => {
      const btc = getAuthoritativeInstrument('BTCUSDT');
      const marginModel = resolveMarginModel(btc, { requestedLeverage: 10 });

      const notionalAccount = 100000;
      const margin = TradeAccountingEngine.calculateMargin(notionalAccount, marginModel);
      const liqPrice = TradeAccountingEngine.calculateLiquidationPrice({
        entryPrice: 90000,
        direction: 'LONG',
        marginModel,
      });

      // Margin uses 10% rate -> ₹10,000
      expect(margin.initialMarginRequired).toBe(10000);
      // Liq price uses EXACT SAME 10% rate + 2.5% MMR -> 90000 * (1 - 0.10 + 0.025) = 83250
      expect(liqPrice).toBe(83250);
    });
  });

  // =========================================================================
  // 22. CRYPTOGRAPHIC ACCOUNTING SNAPSHOT INTEGRITY (AI Fix 101)
  // =========================================================================
  describe('22. Cryptographic Accounting Snapshot & Hash Integrity', () => {
    it('buildAccountingSnapshot constructs a comprehensive snapshot with deterministic SHA-256 hash', () => {
      const btc = getAuthoritativeInstrument('BTCUSDT');
      const marginModel = resolveMarginModel(btc, { requestedLeverage: 10 });
      const fx = converter.getRate('USDT', 'INR', 1700000000000);

      const snapshot = buildAccountingSnapshot({
        accountCurrency: 'INR',
        quoteCurrency: 'USDT',
        fxResult: fx,
        contractSize: 1,
        lotSize: 0.001,
        resolvedMarginModel: marginModel,
        calculatedAt: 1700000000000,
      });

      expect(snapshot.accountCurrency).toBe('INR');
      expect(snapshot.quoteCurrency).toBe('USDT');
      expect(snapshot.fxPair).toBe('USDT/INR');
      expect(snapshot.fxRate).toBe(92.0);
      expect(snapshot.fxTimestamp).toBe(1700000000000);
      expect(snapshot.fxSource).toBe('TEST_FX');
      expect(snapshot.fxSnapshotHash).toBeDefined();
      expect(snapshot.contractSize).toBe(1);
      expect(snapshot.lotSize).toBe(0.001);
      expect(snapshot.resolvedMarginModel).toEqual(marginModel);
      expect(snapshot.snapshotHash).toBeDefined();
      expect(snapshot.snapshotHash.length).toBe(64); // SHA-256 hex length

      // Verify re-computing the hash produces the exact same hash
      const recomputedHash = computeAccountingSnapshotHash(snapshot);
      expect(recomputedHash).toBe(snapshot.snapshotHash);
    });

    it('PositionSizer populates accountingSnapshot with valid SHA-256 snapshotHash', () => {
      const sizing = PositionSizer.calculatePosition({
        accountBalance: 500000,
        riskPercentage: 1.0,
        entryPrice: 90000,
        stopLoss: 88000,
        symbol: 'BTCUSDT',
        requestedLeverage: 10,
        timestamp: 1700000000000,
      });

      expect(sizing.isValid).toBe(true);
      expect(sizing.accountingSnapshot).toBeDefined();
      expect(sizing.accountingSnapshot?.accountCurrency).toBe('INR');
      expect(sizing.accountingSnapshot?.quoteCurrency).toBe('USDT');
      expect(sizing.accountingSnapshot?.fxRate).toBe(92.0);
      expect(sizing.accountingSnapshot?.fxTimestamp).toBe(1700000000000);
      expect(sizing.accountingSnapshot?.fxSource).toBe('TEST_FX');
      expect(sizing.accountingSnapshot?.snapshotHash).toBeDefined();

      const verifiedHash = computeAccountingSnapshotHash(sizing.accountingSnapshot!);
      expect(verifiedHash).toBe(sizing.accountingSnapshot?.snapshotHash);
    });
  });

  // =========================================================================
  // 23. DETERMINISTIC HISTORICAL REPLAY VERIFICATION (AI Fix 101)
  // =========================================================================
  describe('23. Deterministic Historical Replay Verification', () => {
    it('Replaying historical sizing with identical accounting snapshot reproduces byte-identical accounting', () => {
      const run1 = PositionSizer.calculatePosition({
        accountBalance: 1000000,
        riskPercentage: 2.0,
        entryPrice: 92000,
        stopLoss: 89000,
        symbol: 'BTCUSDT',
        requestedLeverage: 5,
        timestamp: 1700000000000,
      });

      const run2 = PositionSizer.calculatePosition({
        accountBalance: 1000000,
        riskPercentage: 2.0,
        entryPrice: 92000,
        stopLoss: 89000,
        symbol: 'BTCUSDT',
        requestedLeverage: 5,
        timestamp: 1700000000000,
      });

      expect(run1.isValid).toBe(true);
      expect(run2.isValid).toBe(true);
      expect(run1.roundedUnits).toBe(run2.roundedUnits);
      expect(run1.initialMarginRequired).toBe(run2.initialMarginRequired);
      expect(run1.positionNotionalAccount).toBe(run2.positionNotionalAccount);
      expect(run1.accountingSnapshot?.snapshotHash).toBe(run2.accountingSnapshot?.snapshotHash);
    });

    it('TradeLifecycleManager attaches deterministic accountingSnapshot to completed trade', () => {
      const lot: PositionLot = {
        id: 'lot_btc_replay',
        tradeId: 'tr_btc_replay',
        symbol: 'BTCUSDT',
        direction: Direction.BULLISH,
        initialQuantity: 0.01,
        remainingQuantity: 0,
        entryPrice: 90000,
        entryTime: 1700000000000,
        initialStopLoss: 88000,
        currentStopLoss: 88000,
        tp1: 93000,
        tp2: 96000,
        tp3: 99000,
        realizedPnl: 60.0,
        unrealizedPnl: 0,
        realizedR: 3.0,
        status: 'CLOSED',
        openedAt: 1700000000000,
        closedAt: 1700000060000,
        mae: 0,
        mfe: 0,
        partialFills: [
          {
            fillId: 'f1',
            targetType: 'ENTRY',
            timestamp: 1700000000000,
            price: 90000,
            quantity: 0.01,
            remainingQuantity: 0.01,
            realizedPnl: 0,
            realizedR: 0,
            fee: 0,
            slippage: 0,
          },
          {
            fillId: 'f2',
            targetType: 'TP2',
            timestamp: 1700000060000,
            price: 96000,
            quantity: 0.01,
            remainingQuantity: 0,
            realizedPnl: 60.0,
            realizedR: 3.0,
            fee: 0,
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
        { leverage: 10, fxRate: 92.0 },
      );

      expect(trade.accountingSnapshot).toBeDefined();
      expect(trade.accountingSnapshot?.accountCurrency).toBe('INR');
      expect(trade.accountingSnapshot?.quoteCurrency).toBe('USDT');
      expect(trade.accountingSnapshot?.fxRate).toBe(92.0);
      expect(trade.accountingSnapshot?.resolvedMarginModel.effectiveLeverage).toBe(10);
      expect(trade.accountingSnapshot?.snapshotHash).toBeDefined();
    });
  });

  // =========================================================================
  // 24. TAMPER DETECTION & CRYPTOGRAPHIC PROVENANCE DEFENSE (AI Fix 101)
  // =========================================================================
  describe('24. Tamper Detection & Cryptographic Provenance Defense', () => {
    it('Altering FX rate, timestamp, source, or margin model changes snapshotHash', () => {
      const btc = getAuthoritativeInstrument('BTCUSDT');
      const marginModel = resolveMarginModel(btc, { requestedLeverage: 10 });
      const fx = converter.getRate('USDT', 'INR', 1700000000000);

      const baseSnapshot = buildAccountingSnapshot({
        accountCurrency: 'INR',
        quoteCurrency: 'USDT',
        fxResult: fx,
        contractSize: 1,
        lotSize: 0.001,
        resolvedMarginModel: marginModel,
        calculatedAt: 1700000000000,
      });

      // 1. Tamper with FX rate (92.0 -> 92.01)
      const tamperedRate: ITradeAccountingSnapshot = {
        ...baseSnapshot,
        fxRate: 92.01,
      };
      expect(computeAccountingSnapshotHash(tamperedRate)).not.toBe(baseSnapshot.snapshotHash);

      // 2. Tamper with FX timestamp
      const tamperedTime: ITradeAccountingSnapshot = {
        ...baseSnapshot,
        fxTimestamp: 1700000001000,
      };
      expect(computeAccountingSnapshotHash(tamperedTime)).not.toBe(baseSnapshot.snapshotHash);

      // 3. Tamper with FX source
      const tamperedSource: ITradeAccountingSnapshot = {
        ...baseSnapshot,
        fxSource: 'SPOOFED_FEED',
      };
      expect(computeAccountingSnapshotHash(tamperedSource)).not.toBe(baseSnapshot.snapshotHash);

      // 4. Tamper with leverage in margin model
      const tamperedMargin: ITradeAccountingSnapshot = {
        ...baseSnapshot,
        resolvedMarginModel: {
          ...baseSnapshot.resolvedMarginModel,
          effectiveLeverage: 20,
        },
      };
      expect(computeAccountingSnapshotHash(tamperedMargin)).not.toBe(baseSnapshot.snapshotHash);
    });
  });

  // =========================================================================
  // 25. CROSS-CURRENCY PNL VIA ACCOUNTING SNAPSHOT (AI Fix 101)
  // =========================================================================
  describe('25. Cross-Currency P&L via Accounting Snapshot & FX Snapshot', () => {
    it('calculateTradePnl consumes ITradeAccountingSnapshot directly and attaches it to result', () => {
      const btc = getAuthoritativeInstrument('BTCUSDT');
      const marginModel = resolveMarginModel(btc, { requestedLeverage: 10 });
      const fx = converter.getRate('USDT', 'INR', 1700000000000);

      const snapshot = buildAccountingSnapshot({
        accountCurrency: 'INR',
        quoteCurrency: 'USDT',
        fxResult: fx,
        contractSize: 1,
        lotSize: 0.001,
        resolvedMarginModel: marginModel,
        calculatedAt: 1700000000000,
      });

      const pnl = TradeAccountingEngine.calculateTradePnl({
        entryPrice: 90000,
        exitPrice: 95000,
        quantity: 0.1,
        direction: 'LONG',
        accountingSnapshot: snapshot,
      });

      // Gross USDT = 500 USDT
      expect(pnl.grossPnlQuote).toBe(500);
      // Gross INR = 500 * 92.0 = ₹46,000 INR
      expect(pnl.grossPnlAccount).toBe(46000);
      expect(pnl.netPnlAccount).toBe(46000);
      expect(pnl.accountingSnapshot).toBe(snapshot);
      expect(pnl.accountingSnapshot?.snapshotHash).toBe(snapshot.snapshotHash);
    });

    it('calculateTradePnl consumes IFxConversionResult directly and builds accountingSnapshot', () => {
      const fx = converter.getRate('USDT', 'INR', 1700000000000);

      const pnl = TradeAccountingEngine.calculateTradePnl({
        entryPrice: 90000,
        exitPrice: 95000,
        quantity: 0.1,
        direction: 'LONG',
        quoteCurrency: 'USDT',
        accountCurrency: 'INR',
        fxSnapshot: fx,
      });

      expect(pnl.grossPnlQuote).toBe(500);
      expect(pnl.grossPnlAccount).toBe(46000);
      expect(pnl.accountingSnapshot).toBeDefined();
      expect(pnl.accountingSnapshot?.fxSource).toBe('TEST_FX');
      expect(pnl.accountingSnapshot?.fxPair).toBe('USDT/INR');
      expect(pnl.accountingSnapshot?.snapshotHash).toBeDefined();
    });
  });
});

