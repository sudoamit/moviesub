import { Test, TestingModule } from '@nestjs/testing';
import { OptionsService } from '../options.service';
import { MarketDataUnavailableError, StaleMarketDataError } from '@quant/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RealMarketStreamerService } from '../../market-data/real-market-streamer.service';
import { BlackScholesModel } from '@quant/trading-engine';

describe('NIFTY Spot vs Trigger Architectural Separation Suite (Section 17)', () => {
  let optionsService: OptionsService;
  let mockRealMarketStreamer: any;
  let mockPrismaService: any;

  beforeEach(() => {
    mockPrismaService = {
      instrument: {
        findUnique: jest.fn().mockResolvedValue({ id: 'inst-1', symbol: 'NIFTY' }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      candle: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    mockRealMarketStreamer = {
      getAuthoritativeSnapshot: jest.fn(),
      getValidatedTicker: jest.fn(),
    };

    optionsService = new OptionsService(
      mockPrismaService as PrismaService,
      mockRealMarketStreamer as RealMarketStreamerService,
    );
  });

  // =========================================================================
  // TEST 1: Current spot = 23060, trigger = 24175.65
  // Expected: currentSpot remains 23060, trigger remains 24175.65
  // =========================================================================
  it('TEST 1: currentSpot = 23060 and trigger = 24175.65 remain strictly distinct in recommendation', async () => {
    const rec = await optionsService.getSmartStrikeRecommendation({
      symbol: 'NIFTY',
      direction: 'BULLISH',
      currentSpotPrice: 23060,
      underlyingTriggerPrice: 24175.65,
      strikeOverride: 24200,
    });

    expect(rec.currentSpotPrice).toBe(23060);
    expect(rec.underlyingTriggerPrice).toBe(24175.65);
    expect(rec.currentSpotPrice).not.toBe(rec.underlyingTriggerPrice);
  });

  // =========================================================================
  // TEST 2: NIFTY strike = 24200
  // Expected: strike remains 24200, NEVER 242 (fixes strikePrice / 100 bug)
  // =========================================================================
  it('TEST 2: NIFTY strike = 24200 remains 24200 and NEVER becomes 242', () => {
    // 1. Strike in Rupees
    const rupeeStrike = optionsService.normalizeExchangeStrike(24200);
    expect(rupeeStrike).toBe(24200);
    expect(rupeeStrike).not.toBe(242);

    // 2. Strike in Paise (Groww provider format >= 500,000 paise)
    const paiseStrike = optionsService.normalizeExchangeStrike(2420000);
    expect(paiseStrike).toBe(24200);
    expect(paiseStrike).not.toBe(242);

    // 3. 50000 strike (e.g. BANKNIFTY) in rupees
    const bankRupee = optionsService.normalizeExchangeStrike(52000);
    expect(bankRupee).toBe(52000);
    expect(bankRupee).not.toBe(520);
  });

  // =========================================================================
  // TEST 3: currentSpot = 23060, bullish trigger = 24175.65
  // Expected: WAITING_FOR_TRIGGER (since 23060 < 24175.65)
  // =========================================================================
  it('TEST 3: currentSpot = 23060 and bullish trigger = 24175.65 produces WAITING_FOR_TRIGGER', async () => {
    const rec = await optionsService.getSmartStrikeRecommendation({
      symbol: 'NIFTY',
      direction: 'BULLISH',
      currentSpotPrice: 23060,
      underlyingTriggerPrice: 24175.65,
      strikeOverride: 24200,
    });

    expect(rec.triggerConditionSatisfied).toBe(false);
    expect(rec.status).toBe('WAITING_FOR_TRIGGER');
    expect(rec.distanceToTrigger).toBe(1115.65);
  });

  // =========================================================================
  // TEST 4: currentSpot = 24180, trigger = 24175.65
  // Expected: trigger condition satisfied (since 24180 >= 24175.65)
  // =========================================================================
  it('TEST 4: currentSpot = 24180 and bullish trigger = 24175.65 marks trigger condition satisfied', async () => {
    const rec = await optionsService.getSmartStrikeRecommendation({
      symbol: 'NIFTY',
      direction: 'BULLISH',
      currentSpotPrice: 24180,
      underlyingTriggerPrice: 24175.65,
      strikeOverride: 24200,
    });

    // Trigger satisfied, but there is no live execution-feed quote for the contract:
    // the setup is NOT ELIGIBLE, never READY (trigger satisfaction != execution eligibility).
    expect(rec.triggerConditionSatisfied).toBe(true);
    expect(rec.executionEligible).toBe(false);
    expect(rec.status).toBe('NOT_ELIGIBLE');
    expect(rec.ineligibilityReasons?.[0]).toMatch(/NO_LIVE_OPTION_QUOTE/);
    expect(rec.distanceToTrigger).toBe(4.35);
  });

  it('TEST 4b: trigger satisfied AND live option quote present => READY_FOR_EXECUTION', async () => {
    mockRealMarketStreamer.getOptionTicker = jest.fn().mockReturnValue({
      symbol: 'NIFTY 24200 CE',
      price: 60.5,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: Date.now(),
    });

    const rec = await optionsService.getSmartStrikeRecommendation({
      symbol: 'NIFTY',
      direction: 'BULLISH',
      currentSpotPrice: 24180,
      underlyingTriggerPrice: 24175.65,
      strikeOverride: 24200,
    });

    expect(rec.triggerConditionSatisfied).toBe(true);
    expect(rec.executionEligible).toBe(true);
    expect(rec.premiumSource).toBe('LIVE_EXECUTION_FEED');
    expect(rec.status).toBe('READY_FOR_EXECUTION');
  });

  it('TEST 4c: no strategy trigger supplied => NO_TRIGGER, never READY', async () => {
    const rec = await optionsService.getSmartStrikeRecommendation({
      symbol: 'NIFTY',
      direction: 'BULLISH',
      currentSpotPrice: 24180,
      strikeOverride: 24200,
    });

    expect(rec.triggerProvided).toBe(false);
    expect(rec.triggerConditionSatisfied).toBe(false);
    expect(rec.status).toBe('NO_TRIGGER');
  });

  it('TEST 4d: a live spot always wins over a client-supplied currentSpotPrice', async () => {
    mockRealMarketStreamer.getAuthoritativeSnapshot.mockReturnValue({
      symbol: 'NIFTY',
      price: 23060,
      marketEventTime: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      provenance: 'LIVE_PROVIDER',
      providerId: 'NSE_YAHOO_REST',
      providerTransport: 'REST_POLLING',
      isFresh: true,
    });

    const rec = await optionsService.getSmartStrikeRecommendation({
      symbol: 'NIFTY',
      direction: 'BULLISH',
      currentSpotPrice: 24175.65, // e.g. a trigger mistakenly sent as spot
      underlyingTriggerPrice: 24175.65,
      strikeOverride: 24200,
    });

    expect(rec.currentSpotPrice).toBe(23060);
    expect(rec.status).toBe('WAITING_FOR_TRIGGER');
  });

  // =========================================================================
  // TEST 5: No live quote
  // Expected: MARKET_DATA_UNAVAILABLE (no hardcoded fallback to 24007.35 in live trading)
  // =========================================================================
  it('TEST 5: missing live market data throws MarketDataUnavailableError without fabrication', async () => {
    mockRealMarketStreamer.getAuthoritativeSnapshot.mockImplementation(() => {
      throw new MarketDataUnavailableError('NIFTY', 'No fresh live market data available for NIFTY');
    });
    mockRealMarketStreamer.getValidatedTicker.mockReturnValue(null);

    await expect(
      optionsService.getSmartStrikeRecommendation({
        symbol: 'NIFTY',
        direction: 'BULLISH',
        // Omitting currentSpotPrice forces lookup in authoritative live streamer
      }),
    ).rejects.toThrow(MarketDataUnavailableError);
  });

  // =========================================================================
  // TEST 6: Stale quote
  // Expected: MARKET_DATA_STALE (quote older than staleness threshold rejected)
  // =========================================================================
  it('TEST 6: stale quote throws StaleMarketDataError without falling back to hardcoded price', async () => {
    const staleTimestamp = Date.now() - 60000; // 60 seconds old (threshold is 10s)
    mockRealMarketStreamer.getAuthoritativeSnapshot.mockReturnValue({
      symbol: 'NIFTY',
      price: 23060,
      marketEventTime: new Date(staleTimestamp).toISOString(),
      observedAt: new Date(staleTimestamp).toISOString(),
      receivedAt: new Date(staleTimestamp).toISOString(),
      provenance: 'LIVE_PROVIDER',
      providerId: 'NSE_YAHOO_REST',
      providerTransport: 'REST_POLLING',
      isFresh: false,
    });
    mockRealMarketStreamer.getValidatedTicker.mockReturnValue({
      symbol: 'NIFTY',
      price: 23060,
      lastUpdated: staleTimestamp,
      provenance: 'LIVE_PROVIDER',
    });

    await expect(
      optionsService.getSmartStrikeRecommendation({
        symbol: 'NIFTY',
        direction: 'BULLISH',
      }),
    ).rejects.toThrow(StaleMarketDataError);
  });

  // =========================================================================
  // TEST 7: Strategy trigger is 24175.65
  // Verify this value does NOT populate currentSpotPrice
  // =========================================================================
  it('TEST 7: strategy trigger of 24175.65 does NOT overwrite or populate currentSpotPrice', async () => {
    mockRealMarketStreamer.getAuthoritativeSnapshot.mockReturnValue({
      symbol: 'NIFTY',
      price: 23060,
      marketEventTime: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      provenance: 'LIVE_PROVIDER',
      providerId: 'NSE_YAHOO_REST',
      providerTransport: 'REST_POLLING',
      isFresh: true,
    });

    const rec = await optionsService.getSmartStrikeRecommendation({
      symbol: 'NIFTY',
      direction: 'BULLISH',
      underlyingTriggerPrice: 24175.65,
      strikeOverride: 24200,
    });

    expect(rec.currentSpotPrice).toBe(23060);
    expect(rec.underlyingTriggerPrice).toBe(24175.65);
    expect(rec.currentSpotPrice).not.toBe(rec.underlyingTriggerPrice);
  });

  // =========================================================================
  // TEST 8: Current spot is 23060
  // Verify option Black-Scholes / current-market valuation uses 23060
  // =========================================================================
  it('TEST 8: Black-Scholes current-market valuation explicitly uses currentSpot (23060)', () => {
    const timeToExpiryYears = 5 / 365;
    const riskFreeRate = 0.07;
    const volatility = 0.14;
    const strike = 24200;

    // Spot = 23060 is deep OTM for a 24200 CE strike
    const otmValuation = BlackScholesModel.calculate(
      23060, // Current underlying spot
      strike,
      timeToExpiryYears,
      riskFreeRate,
      volatility,
      'CE',
    );

    // Deep OTM CE premium at 23060 should be near zero (~0.00 to 0.05)
    expect(otmValuation.price).toBeLessThan(1.0);
    expect(otmValuation.greeks.delta).toBeLessThan(0.05);

    // If spot was incorrectly set to 24175.65, it would be ATM with price > 50 and delta ~ 0.50
    const triggerValuation = BlackScholesModel.calculate(
      24175.65, // Trigger scenario spot
      strike,
      timeToExpiryYears,
      riskFreeRate,
      volatility,
      'CE',
    );
    expect(triggerValuation.price).toBeGreaterThan(40.0);
    expect(triggerValuation.greeks.delta).toBeGreaterThan(0.40);
  });

  // =========================================================================
  // TEST 9: Trigger-scenario valuation uses 24175.65 ONLY when explicitly requested
  // =========================================================================
  it('TEST 9: trigger-scenario valuation uses 24175.65 ONLY for plannedEntryPremium, not currentOptionLtp', async () => {
    const rec = await optionsService.getSmartStrikeRecommendation({
      symbol: 'NIFTY',
      direction: 'BULLISH',
      currentSpotPrice: 23060,
      underlyingTriggerPrice: 24175.65,
      strikeOverride: 24200,
    });

    // 1. Current Option LTP reflects live market spot 23060 (deep OTM CE is low)
    expect(rec.currentOptionLtp).toBeLessThan(5.0);
    expect(rec.currentOptionLtp).toBeLessThan(rec.plannedEntryPremium);

    // 2. Planned Entry Premium reflects the ATM scenario at trigger spot 24175.65 (substantial option value)
    expect(rec.plannedEntryPremium).toBeGreaterThan(40.0);
  });

  // =========================================================================
  // TEST 10: UI data contract contains currentSpotPrice and underlyingTriggerPrice separately
  // =========================================================================
  it('TEST 10: ISmartOptionRecommendation data structure contains separated spot, trigger, contract, and premiums', async () => {
    const rec = await optionsService.getSmartStrikeRecommendation({
      symbol: 'NIFTY',
      direction: 'BULLISH',
      currentSpotPrice: 23060,
      underlyingTriggerPrice: 24175.65,
      strikeOverride: 24200,
    });

    // Verify all required architectural fields exist and are distinct
    expect(rec).toHaveProperty('underlyingSymbol', 'NIFTY');
    expect(rec).toHaveProperty('currentSpotPrice', 23060);
    expect(rec).toHaveProperty('underlyingTriggerPrice', 24175.65);
    expect(rec).toHaveProperty('distanceToTrigger', 1115.65);
    expect(rec).toHaveProperty('triggerConditionSatisfied', false);
    expect(rec).toHaveProperty('status', 'WAITING_FOR_TRIGGER');

    expect(rec.optionContract).toBeDefined();
    expect(rec.optionContract.strike).toBe(24200);
    expect(rec.optionContract.optionType).toBe('CE');
    expect(rec.optionContract.lotSize).toBe(65);

    expect(rec).toHaveProperty('currentOptionLtp');
    expect(rec).toHaveProperty('plannedEntryPremium');
    expect(rec).toHaveProperty('plannedStopPremium');
    expect(rec).toHaveProperty('targets');
    expect(rec.targets).toHaveProperty('tp1');
    expect(rec.targets).toHaveProperty('tp2');
    expect(rec.targets).toHaveProperty('tp3');
  });

  // =========================================================================
  // TEST 11: Option Premium Trigger (+/- 1% touch / band)
  // =========================================================================
  it('TEST 11: triggerMode = OPTION_PREMIUM triggers when option price is within +/- 1% of planned entry', async () => {
    const params = {
      symbol: 'NIFTY',
      direction: 'BULLISH' as const,
      currentSpotPrice: 24175.65,
      underlyingTriggerPrice: 24175.65,
      strikeOverride: 24200,
      triggerMode: 'OPTION_PREMIUM' as const,
    };
    // The planned premium is model-derived and depends on time to expiry, so read it instead of hardcoding it.
    const baseline = await optionsService.getSmartStrikeRecommendation(params);
    const planned = baseline.plannedEntryPremium;
    expect(planned).toBeGreaterThan(0);

    // 1. Live option ticker within +/- 1% of the planned entry (+0.5%)
    mockRealMarketStreamer.getOptionTicker = jest.fn().mockReturnValue({
      symbol: 'NIFTY 24200 CE',
      price: Number((planned * 1.005).toFixed(2)),
      provenance: 'LIVE_PROVIDER',
      marketEventTime: Date.now(),
    });
    const recTriggered = await optionsService.getSmartStrikeRecommendation(params);
    expect(recTriggered.triggerConditionSatisfied).toBe(true);
    expect(recTriggered.status).toBe('READY_FOR_EXECUTION');

    // 2. Live option ticker outside +/- 1% (-22%)
    mockRealMarketStreamer.getOptionTicker = jest.fn().mockReturnValue({
      symbol: 'NIFTY 24200 CE',
      price: Number((planned * 0.78).toFixed(2)),
      provenance: 'LIVE_PROVIDER',
      marketEventTime: Date.now(),
    });
    const recWaiting = await optionsService.getSmartStrikeRecommendation(params);
    expect(recWaiting.triggerConditionSatisfied).toBe(false);
    expect(recWaiting.status).toBe('WAITING_FOR_TRIGGER');
  });
});
