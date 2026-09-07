import { ExecutionSafetyGate, IExecutionSafetyGateParams } from '../execution-safety-gate';
import { Direction } from '@quant/shared';

describe('ExecutionSafetyGate', () => {
  const getValidParams = (): IExecutionSafetyGateParams => ({
    instrument: 'NIFTY',
    direction: Direction.BULLISH,
    mode: 'PAPER',
    marketDataQuality: {
      isValid: true,
      symbol: 'NIFTY',
      timeframe: '15m',
      checkedAt: new Date(),
      staleData: false,
      missingCandlesCount: 0,
      duplicateCandlesCount: 0,
      abnormalPriceJumpsCount: 0,
      zeroVolumeCount: 0,
      feedDisconnected: false,
      reasons: [],
    },
    smcSetup: {
      instrument: 'NIFTY',
      direction: 'BULLISH',
      entry_zone: { min: 24000, max: 24020, optimal: 24010 },
      stop_loss: { price: 23970, risk_pts: 40, risk_percent: 0.17 },
      tp1: { price: 24070, reward_r: 1.5 },
      tp2: { price: 24110, reward_r: 2.5 },
      tp3: { price: 24170, reward_r: 4.0 },
      risk_reward: 2.5,
      setup_timestamp: new Date().toISOString(),
      smc_score: 92,
      confluenceChecklist: ['Liquidity Sweep', 'Bullish FVG', '4H Alignment'],
    },
    featureVector: {
      htfTrendAlignment: 1,
      trend4H: 1,
      trend1H: 1,
      structure15M: 1,
      bosChochQuality: 0.85,
      orderBlockStrength: 0.9,
      fvgSize: 0.75,
      fvgFillPct: 0.3,
      liquiditySweepDepth: 0.8,
      displacementIntensity: 0.85,
      atrVolatility: 0.5,
      volumeImbalance: 0.7,
      cvd: 0.65,
      volumeProfilePocProximity: 0.9,
      sessionKillZone: 1.0,
      marketRegime: 1.0,
      smtDivergence: 0.8,
      feature_timestamp: new Date().toISOString(),
      source_candle_timestamp: new Date().toISOString(),
      calculation_timestamp: new Date().toISOString(),
    },
    modelState: {
      status: 'ACTIVE',
      isDrifted: false,
    },
    prediction: {
      rawProbability: 0.72,
      calibratedProbability: 0.68,
      expectedR: 0.85,
    },
    positionSizing: {
      accountBalance: 500000,
      riskPercentage: 1.0,
      riskAmount: 5000,
      entryPrice: 24010,
      stopLoss: 23970,
      riskPerUnit: 40,
      calculatedUnits: 125,
      lotSize: 65,
      roundedUnits: 130,
      totalPositionValue: 3121300,
      maximumLoss: 5200,
      isValid: true,
    },
    accountEquity: 500000,
    openPositions: [],
    minExpectancyR: 0.2,
    isSessionActive: true,
  });

  it('should approve a fully compliant SMC + ML candidate trade', () => {
    const params = getValidParams();
    const result = ExecutionSafetyGate.evaluate(params);

    expect(result.isApproved).toBe(true);
    expect(result.rejectionReasons.length).toBe(0);
    expect(result.checks['1_DATA_QUALITY'].passed).toBe(true);
    expect(result.checks['6_EXPECTANCY_R'].passed).toBe(true);
    expect(result.checks['10_STOP_LOSS_STRUCTURE'].passed).toBe(true);
  });

  it('should reject trade if market data quality fails', () => {
    const params = getValidParams();
    params.marketDataQuality.isValid = false;
    params.marketDataQuality.reasons = ['Stale market feed: 45 min old'];

    const result = ExecutionSafetyGate.evaluate(params);
    expect(result.isApproved).toBe(false);
    expect(result.rejectionReasons).toContain('Data quality failed: Stale market feed: 45 min old');
  });

  it('should reject trade if mathematical expectancy is below threshold', () => {
    const params = getValidParams();
    params.prediction.expectedR = 0.05; // Below 0.20R
    params.minExpectancyR = 0.2;

    const result = ExecutionSafetyGate.evaluate(params);
    expect(result.isApproved).toBe(false);
    expect(result.checks['6_EXPECTANCY_R'].passed).toBe(false);
  });

  it('should reject trade if stop loss is on wrong side of entry', () => {
    const params = getValidParams();
    params.positionSizing.stopLoss = 24100; // Above entry for a Bullish trade!

    const result = ExecutionSafetyGate.evaluate(params);
    expect(result.isApproved).toBe(false);
    expect(result.checks['10_STOP_LOSS_STRUCTURE'].passed).toBe(false);
  });

  it('should reject trade if model is flagged with drift or is disabled', () => {
    const params = getValidParams();
    params.modelState.isDrifted = true;

    const result = ExecutionSafetyGate.evaluate(params);
    expect(result.isApproved).toBe(false);
    expect(result.checks['4_MODEL_HEALTH'].passed).toBe(false);
  });
});
