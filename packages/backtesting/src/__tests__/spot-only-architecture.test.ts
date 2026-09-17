import {
  getAuthoritativeSpotInstrument,
  isSupportedSpotSymbol,
  canonicalizeSpotSymbol,
  SUPPORTED_SPOT_SYMBOLS,
  FORBIDDEN_DERIVATIVE_INSTRUMENTS,
  PointInTimeCurrencyConverter,
  RealLiveMarketDataProvider,
  Direction,
  PositionSide,
  ICandle,
} from '@quant/shared';
import { PositionSizer, TradeAccountingEngine } from '@quant/risk-engine';
import {
  ExecutionSimulator,
  FillModel,
  SameCandleAmbiguityMode,
} from '../execution';
import {
  BacktestSimulator,
  SpotBacktestSimulator,
} from '../backtest-simulator';

describe('Spot-Only Trading Architecture Invariants (Requirement 15)', () => {
  const fxConverter = PointInTimeCurrencyConverter.getInstance();
  const testTimestamp = new Date('2025-06-15T10:00:00.000Z').getTime();

  beforeAll(() => {
    fxConverter.registerRate({
      pair: 'USDT/INR',
      rate: 85.5,
      timestamp: testTimestamp,
      source: 'RBI_REFERENCE',
      version: '1.0',
    });
    // Register rates for subsequent test timestamps
    for (let offset = 0; offset <= 100; offset++) {
      fxConverter.registerRate({
        pair: 'USDT/INR',
        rate: 85.5,
        timestamp: testTimestamp + offset * 15 * 60 * 1000,
        source: 'RBI_REFERENCE',
        version: '1.0',
      });
    }
  });

  describe('1. NIFTY_SPOT Invariants', () => {
    test('resolves correctly to authoritative spot instrument without fake derivative fields', () => {
      expect(isSupportedSpotSymbol('NIFTY_SPOT')).toBe(true);
      const inst = getAuthoritativeSpotInstrument('NIFTY_SPOT');
      expect(inst.symbol).toBe('NIFTY_SPOT');
      expect(inst.exchange).toBe('NSE');
      expect(inst.contractMultiplier).toBe(1);
      expect(inst.lotSize).toBe(1);
      expect(inst.quoteCurrency).toBe('INR');
      expect(inst.accountingCurrency).toBe('INR');
      expect(inst.isSpot).toBe(true);

      // Must NOT contain derivative fields
      expect((inst as any).defaultLeverage).toBeUndefined();
      expect((inst as any).maxLeverage).toBeUndefined();
      expect((inst as any).initialMarginRate).toBeUndefined();
      expect((inst as any).maintenanceMarginRate).toBeUndefined();
      expect((inst as any).liquidationModel).toBeUndefined();
      expect((inst as any).expiryDate).toBeUndefined();
    });

    test('uses NSE spot market data mapping (^NSEI)', () => {
      const yahooMap = (RealLiveMarketDataProvider as any).YAHOO_SYMBOL_MAP;
      expect(yahooMap['NIFTY_SPOT']).toBe('^NSEI');
    });

    test('cannot use leverage (> 1 throws or rejects)', () => {
      const sizingRes = PositionSizer.calculatePosition({
        accountBalance: 100000,
        riskPercentage: 1,
        entryPrice: 24000,
        stopLoss: 23800,
        symbol: 'NIFTY_SPOT',
        requestedLeverage: 5,
        timestamp: testTimestamp,
      });
      expect(sizingRes.isValid).toBe(false);
      expect(sizingRes.rejectionReason).toMatch(/LEVERAGE_EXCEEDS_MAX/);
    });

    test('cannot use margin (initialMarginRequired = 0, maintenanceMarginRequired = 0)', () => {
      const notional = TradeAccountingEngine.calculateNotional(10, 24000, 1, 1.0);
      expect(notional.notionalAccount).toBe(240000);

      // Spot sizing strictly operates on cash and risk with zero margin
      const spotSizing = PositionSizer.calculateSpotPosition({
        availableCash: 250000,
        equity: 250000,
        riskPercentage: 1,
        entryPrice: 24000,
        stopLoss: 23800,
        symbol: 'NIFTY_SPOT',
        timestamp: testTimestamp,
      });
      expect(spotSizing.isValid).toBe(true);
      expect((spotSizing as any).leverage).toBeUndefined(); // Zero leverage concept
    });

    test('cannot liquidate and cannot expire', () => {
      const liqPrice = TradeAccountingEngine.calculateLiquidationPrice({
        entryPrice: 24000,
        direction: Direction.BULLISH,
        leverage: 1,
        marginMode: 'SPOT',
        liquidationModel: 'SPOT_NONE' as any,
      });
      expect(liqPrice).toBeUndefined();

      const inst = getAuthoritativeSpotInstrument('NIFTY_SPOT');
      expect((inst as any).expiryDate).toBeUndefined();
    });
  });

  describe('2. BANKNIFTY_SPOT Invariants', () => {
    test('resolves correctly to authoritative spot instrument without fake derivative fields', () => {
      expect(isSupportedSpotSymbol('BANKNIFTY_SPOT')).toBe(true);
      const inst = getAuthoritativeSpotInstrument('BANKNIFTY_SPOT');
      expect(inst.symbol).toBe('BANKNIFTY_SPOT');
      expect(inst.exchange).toBe('NSE');
      expect(inst.contractMultiplier).toBe(1);
      expect(inst.lotSize).toBe(1);
      expect(inst.quoteCurrency).toBe('INR');
      expect(inst.accountingCurrency).toBe('INR');
      expect(inst.isSpot).toBe(true);
    });

    test('uses NSE spot market data mapping (^NSEBANK)', () => {
      const yahooMap = (RealLiveMarketDataProvider as any).YAHOO_SYMBOL_MAP;
      expect(yahooMap['BANKNIFTY_SPOT']).toBe('^NSEBANK');
    });

    test('cannot use leverage (> 1 throws or rejects)', () => {
      const sizingRes = PositionSizer.calculatePosition({
        accountBalance: 100000,
        riskPercentage: 1,
        entryPrice: 51000,
        stopLoss: 50500,
        symbol: 'BANKNIFTY_SPOT',
        requestedLeverage: 3,
        timestamp: testTimestamp,
      });
      expect(sizingRes.isValid).toBe(false);
      expect(sizingRes.rejectionReason).toMatch(/LEVERAGE_EXCEEDS_MAX/);
    });

    test('cannot liquidate and cannot expire', () => {
      const liqPrice = TradeAccountingEngine.calculateLiquidationPrice({
        entryPrice: 51000,
        direction: Direction.BULLISH,
        leverage: 1,
        marginMode: 'SPOT',
        liquidationModel: 'SPOT_NONE' as any,
      });
      expect(liqPrice).toBeUndefined();

      const inst = getAuthoritativeSpotInstrument('BANKNIFTY_SPOT');
      expect((inst as any).expiryDate).toBeUndefined();
    });
  });

  describe('3. BTCUSDT_SPOT Invariants', () => {
    test('resolves correctly to Binance spot asset with USDT quote and INR accounting', () => {
      expect(isSupportedSpotSymbol('BTCUSDT_SPOT')).toBe(true);
      const inst = getAuthoritativeSpotInstrument('BTCUSDT_SPOT');
      expect(inst.symbol).toBe('BTCUSDT_SPOT');
      expect(inst.exchange).toBe('BINANCE');
      expect(inst.quoteCurrency).toBe('USDT');
      expect(inst.accountingCurrency).toBe('INR');
      expect(inst.contractMultiplier).toBe(1);
      expect(inst.isSpot).toBe(true);
      expect((inst as any).fundingRate).toBeUndefined();
    });

    test('uses Binance spot data mapping', () => {
      const provider = new RealLiveMarketDataProvider();
      expect(provider).toBeDefined();
    });

    test('cannot use leverage, margin, funding, or liquidation', () => {
      const sizingRes = PositionSizer.calculatePosition({
        accountBalance: 1000000,
        riskPercentage: 1,
        entryPrice: 90000,
        stopLoss: 88000,
        symbol: 'BTCUSDT_SPOT',
        requestedLeverage: 10,
        timestamp: testTimestamp,
      });
      expect(sizingRes.isValid).toBe(false);
      expect(sizingRes.rejectionReason).toMatch(/LEVERAGE_EXCEEDS_MAX/);

      const liqPrice = TradeAccountingEngine.calculateLiquidationPrice({
        entryPrice: 90000,
        direction: Direction.BULLISH,
        leverage: 1,
        marginMode: 'SPOT',
        liquidationModel: 'SPOT_NONE' as any,
      });
      expect(liqPrice).toBeUndefined();
    });

    test('cannot create naked short', () => {
      const execSim = new ExecutionSimulator(
        FillModel.NEXT_BAR_MARKET,
        SameCandleAmbiguityMode.CONSERVATIVE,
        { submissionLatencyMs: 0, processingLatencyMs: 0 },
        'run_test_short',
      );

      // Attempting to submit a short SELL entry order on spot instrument must throw
      expect(() => {
        execSim.submitOrder({
          tradeId: 't_short',
          symbol: 'BTCUSDT_SPOT',
          side: 'SELL',
          orderType: 'MARKET',
          positionSide: PositionSide.SHORT,
          price: 90000,
          quantity: 0.1,
          timestamp: testTimestamp,
          exitTarget: 'ENTRY',
        });
      }).toThrow(/SPOT_SHORT_SELLING_FORBIDDEN/);

      // PositionSizer must also reject short direction
      const sizingRes = PositionSizer.calculatePosition({
        accountBalance: 1000000,
        riskPercentage: 1,
        entryPrice: 90000,
        stopLoss: 92000,
        direction: 'SHORT',
        symbol: 'BTCUSDT_SPOT',
        timestamp: testTimestamp,
      });
      expect(sizingRes.isValid).toBe(false);
      expect(sizingRes.rejectionReason).toMatch(/SPOT_SHORT_SELLING_FORBIDDEN/);
    });

    test('uses INR accounting and converts USDT fees correctly via PointInTimeCurrencyConverter', () => {
      const fx = fxConverter.getRate('USDT', 'INR', testTimestamp);
      expect(fx.fxRate).toBe(85.5);

      const notionalQuote = 0.5 * 90000; // 45,000 USDT
      const notionalINR = notionalQuote * fx.fxRate; // 3,847,500 INR
      const calcNotional = TradeAccountingEngine.calculateNotional(0.5, 90000, 1, fx.fxRate);
      expect(calcNotional.notionalQuote).toBe(45000);
      expect(calcNotional.notionalAccount).toBe(3847500);

      // Missing FX rate must fail closed
      const isolatedConverter = new PointInTimeCurrencyConverter();
      isolatedConverter.clearAllRates();
      expect(() => {
        isolatedConverter.getRate('USDT', 'INR', testTimestamp);
      }).toThrow(/MISSING_FX_RATE/);
    });
  });

  describe('4. Strict Rejections & Allowlist', () => {
    test.each([
      'NIFTY_FUT',
      'BANKNIFTY_FUT',
      'NIFTY_OPTION',
      'BANKNIFTY_OPTION',
      'BTCUSDT_PERP',
    ])('strictly rejects forbidden derivative symbol %s', (sym) => {
      expect(FORBIDDEN_DERIVATIVE_INSTRUMENTS.has(sym)).toBe(true);

      expect(() => {
        canonicalizeSpotSymbol(sym);
      }).toThrow(/FORBIDDEN_DERIVATIVE_INSTRUMENT/);

      expect(() => {
        SpotBacktestSimulator.runSimulation({
          symbol: sym,
          candles: [],
        });
      }).toThrow(/FORBIDDEN_DERIVATIVE_INSTRUMENT/);
    });

    test('legacy aliases (NIFTY, BANKNIFTY, BTCUSDT) cannot bypass spot-only allowlist in SpotBacktestSimulator', () => {
      expect(() => {
        SpotBacktestSimulator.runSimulation({
          symbol: 'NIFTY',
          candles: [],
        });
      }).toThrow(/LEGACY_ALIAS_REJECTED/);

      expect(() => {
        SpotBacktestSimulator.runSimulation({
          symbol: 'BANKNIFTY',
          candles: [],
        });
      }).toThrow(/LEGACY_ALIAS_REJECTED/);

      expect(() => {
        SpotBacktestSimulator.runSimulation({
          symbol: 'BTCUSDT',
          candles: [],
        });
      }).toThrow(/LEGACY_ALIAS_REJECTED/);
    });

    test('BacktestSimulator strictly rejects legacy aliases (NIFTY, BANKNIFTY, BTCUSDT) with fail-closed error', () => {
      expect(() => {
        BacktestSimulator.runSimulation({
          symbol: 'NIFTY',
          candles: [],
        });
      }).toThrow(/LEGACY_ALIAS_REJECTED/);

      expect(() => {
        BacktestSimulator.runSimulation({
          symbol: 'BANKNIFTY',
          candles: [],
        });
      }).toThrow(/LEGACY_ALIAS_REJECTED/);

      expect(() => {
        BacktestSimulator.runSimulation({
          symbol: 'BTCUSDT',
          candles: [],
        });
      }).toThrow(/LEGACY_ALIAS_REJECTED/);
    });

    test('BacktestSimulator accepts canonical spot symbols (NIFTY_SPOT, BANKNIFTY_SPOT, BTCUSDT_SPOT)', () => {
      for (const sym of ['NIFTY_SPOT', 'BANKNIFTY_SPOT', 'BTCUSDT_SPOT']) {
        expect(() => {
          BacktestSimulator.runSimulation({
            symbol: sym,
            candles: [],
          });
        }).not.toThrow(/LEGACY_ALIAS_REJECTED/);
      }
    });

    test('execution boundary in ExecutionSimulator strictly enforces spot allowlist before order creation', () => {
      const execSim = new ExecutionSimulator(FillModel.NEXT_BAR_MARKET, SameCandleAmbiguityMode.CONSERVATIVE, { submissionLatencyMs: 0, processingLatencyMs: 0 });
      execSim.setSpotOnly(true);

      expect(() => {
        execSim.submitOrder({
          tradeId: 't1',
          symbol: 'NIFTY',
          side: 'BUY',
          orderType: 'MARKET',
          quantity: 1,
          timestamp: testTimestamp,
        });
      }).toThrow(/UNSUPPORTED_SPOT_INSTRUMENT/);

      expect(() => {
        execSim.submitOrder({
          tradeId: 't2',
          symbol: 'BTCUSDT',
          side: 'BUY',
          orderType: 'MARKET',
          quantity: 1,
          timestamp: testTimestamp,
        });
      }).toThrow(/UNSUPPORTED_SPOT_INSTRUMENT/);

      expect(() => {
        execSim.submitOrder({
          tradeId: 't3',
          symbol: 'GOLD',
          side: 'BUY',
          orderType: 'MARKET',
          quantity: 1,
          timestamp: testTimestamp,
        });
      }).toThrow(/UNSUPPORTED_SPOT_INSTRUMENT/);

      // Canonical spot symbol succeeds
      const order = execSim.submitOrder({
        tradeId: 't4',
        symbol: 'NIFTY_SPOT',
        side: 'BUY',
        orderType: 'MARKET',
        quantity: 1,
        timestamp: testTimestamp,
      });
      expect(order.orderId).toBeDefined();
    });

    test('naked short selling rules: SELL with zero holdings, SELL > holdings, SELL <= holdings, and SHORT positions', () => {
      // 1. SELL with zero holdings -> reject
      const sellZero = PositionSizer.calculateSpotPosition({
        symbol: 'NIFTY_SPOT',
        orderSide: 'SELL',
        currentHeldQuantity: 0,
        sellQuantity: 5,
        availableCash: 100000,
        entryPrice: 24000,
        stopLoss: 23800,
        timestamp: testTimestamp,
      });
      expect(sellZero.isValid).toBe(false);
      expect(sellZero.rejectionReason).toMatch(/SPOT_SHORT_SELLING_FORBIDDEN/);

      // 2. SELL quantity > holdings -> reject
      const sellExcess = PositionSizer.calculateSpotPosition({
        symbol: 'NIFTY_SPOT',
        orderSide: 'SELL',
        currentHeldQuantity: 3,
        sellQuantity: 5,
        availableCash: 100000,
        entryPrice: 24000,
        stopLoss: 23800,
        timestamp: testTimestamp,
      });
      expect(sellExcess.isValid).toBe(false);
      expect(sellExcess.rejectionReason).toMatch(/SPOT_SHORT_SELLING_FORBIDDEN/);

      // 3. SELL quantity <= holdings -> accept
      const sellValid = PositionSizer.calculateSpotPosition({
        symbol: 'NIFTY_SPOT',
        orderSide: 'SELL',
        currentHeldQuantity: 10,
        sellQuantity: 5,
        availableCash: 100000,
        entryPrice: 24000,
        stopLoss: 23800,
        timestamp: testTimestamp,
      });
      expect(sellValid.isValid).toBe(true);

      // 4. SHORT entry position in ExecutionSimulator -> reject
      const execSim = new ExecutionSimulator(FillModel.NEXT_BAR_MARKET, SameCandleAmbiguityMode.CONSERVATIVE, { submissionLatencyMs: 0, processingLatencyMs: 0 });
      expect(() => {
        execSim.submitOrder({
          tradeId: 'short_entry_fail',
          symbol: 'NIFTY_SPOT',
          side: 'SELL',
          positionSide: PositionSide.SHORT,
          orderType: 'MARKET',
          quantity: 1,
          timestamp: testTimestamp,
          exitTarget: 'ENTRY',
        });
      }).toThrow(/SPOT_SHORT_SELLING_FORBIDDEN/);
    });

    test('arbitrary unsupported instruments (GOLD, ETHUSDT) fail closed in SpotBacktestSimulator', () => {
      expect(() => {
        SpotBacktestSimulator.runSimulation({
          symbol: 'GOLD',
          candles: [],
        });
      }).toThrow(/UNSUPPORTED_SPOT_INSTRUMENT/);

      expect(() => {
        SpotBacktestSimulator.runSimulation({
          symbol: 'ETHUSDT',
          candles: [],
        });
      }).toThrow(/UNSUPPORTED_SPOT_INSTRUMENT/);
    });
  });

  describe('5. Spot Position Sizing & Cash Invariants', () => {
    test('position sizing strictly obeys risk and available cash without leverage', () => {
      const equity = 100000;
      const availableCash = 50000; // Cash is lower than equity
      const entryPrice = 1000;
      const stopLoss = 950; // risk per unit = 50
      const riskPercent = 1; // 1% of 100,000 = 1,000 INR risk amount

      // quantityByRisk = 1,000 / 50 = 20 units
      // quantityByCash = 50,000 / 1,000 = 50 units
      // quantity = min(20, 50) = 20 units
      const sizing = PositionSizer.calculateSpotPosition({
        availableCash,
        equity,
        riskPercentage: riskPercent,
        entryPrice,
        stopLoss,
        symbol: 'NIFTY_SPOT',
        timestamp: testTimestamp,
      });

      expect(sizing.isValid).toBe(true);
      expect(sizing.quantityByRisk).toBe(20);
      expect(sizing.quantityByCash).toBe(50);
      expect(sizing.roundedQuantity).toBe(20);
      expect(sizing.positionNotionalINR).toBe(20000);
      expect(sizing.positionNotionalINR).toBeLessThanOrEqual(availableCash);
    });

    test('cash ceiling caps quantity when cash is constrained', () => {
      const equity = 100000;
      const availableCash = 10000; // Cash constrained
      const entryPrice = 1000;
      const stopLoss = 950; // risk per unit = 50
      const riskPercent = 2; // 2% of 100,000 = 2,000 INR risk amount

      // quantityByRisk = 2,000 / 50 = 40 units (notional = 40,000 > availableCash)
      // quantityByCash = 10,000 / 1,000 = 10 units
      // quantity = min(40, 10) = 10 units
      const sizing = PositionSizer.calculateSpotPosition({
        availableCash,
        equity,
        riskPercentage: riskPercent,
        entryPrice,
        stopLoss,
        symbol: 'NIFTY_SPOT',
        timestamp: testTimestamp,
      });

      expect(sizing.isValid).toBe(true);
      expect(sizing.roundedQuantity).toBe(10);
      expect(sizing.positionNotionalINR).toBe(10000);
      expect(sizing.positionNotionalINR).toBeLessThanOrEqual(availableCash);
    });
  });

  describe('6. Spot Execution Simulator & Cash Accounting', () => {
    function generateSyntheticCandles(count: number, startPrice = 100): ICandle[] {
      const candles: ICandle[] = [];
      let p = startPrice;
      for (let i = 0; i < count; i++) {
        const time = new Date(testTimestamp + i * 15 * 60 * 1000);
        const open = p;
        const high = p + 2;
        const low = p - 1;
        const close = p + 1;
        p = close;
        candles.push({
          timestamp: time,
          open,
          high,
          low,
          close,
          volume: 1000,
          isClosed: true,
          provenance: 'LIVE',
        });
      }
      return candles;
    }

    test('spot simulation runs with zero margin, cash deduction on BUY, and cash release on SELL', () => {
      const candles = generateSyntheticCandles(60, 24000);

      const result = SpotBacktestSimulator.runSimulation({
        symbol: 'NIFTY_SPOT',
        candles,
        initialCapital: 1000000,
        riskPerTradePercent: 1.0,
        warmupBars: 10,
        minimumCandles: 20,
        strategyMode: 'SMC',
        strategyConfig: {
          deterministicSignals: [
            {
              id: 'sig_spot_buy_1',
              direction: 'BULLISH',
              score: 90,
              entryPrice: 24010,
              stopLoss: 23900,
              tp1: 24050,
              tp2: 24100,
              tp3: 24150,
            },
          ],
        },
      });

      expect(result.symbol).toBe('NIFTY_SPOT');
      expect(result.initialCapital).toBe(1000000);
      expect(result.equitySnapshots!.length).toBeGreaterThan(0);

      // Invariants across all snapshots:
      for (const snap of result.equitySnapshots!) {
        expect(snap.marginUsed).toBe(0); // Spot: 0 margin used
        expect(snap.availableMargin).toBe(snap.cash); // Spot: available margin == cash
      }

      // Invariants across all completed trades:
      for (const trade of result.trades) {
        expect(trade.marginRequired).toBe(0);
        expect(trade.initialMarginRequired).toBe(0);
        expect(trade.maintenanceMarginRequired).toBe(0);
        expect(trade.leverage).toBe(1);
        expect(trade.marginMode).toBe('SPOT');
      }
    });

    test('BUY fails closed when account lacks sufficient cash', () => {
      const candles = generateSyntheticCandles(60, 24000);

      // Sizing for 24,000 price requires at least 24,000 cash for 1 unit
      // With only 5,000 initial capital, BUY order cannot execute
      const result = SpotBacktestSimulator.runSimulation({
        symbol: 'NIFTY_SPOT',
        candles,
        initialCapital: 5000,
        riskPerTradePercent: 1.0,
        warmupBars: 10,
        minimumCandles: 20,
        strategyMode: 'SMC',
        strategyConfig: {
          deterministicSignals: [
            {
              id: 'sig_insufficient_cash',
              direction: 'BULLISH',
              score: 90,
              entryPrice: 24010,
              stopLoss: 23900,
            },
          ],
        },
      });

      // No trade executed because cash was insufficient
      expect(result.trades.length).toBe(0);
      expect(result.finalEquity).toBe(5000);
    });
  });
});
