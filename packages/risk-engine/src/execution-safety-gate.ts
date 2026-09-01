import {
  Direction,
  IExecutionSafetyDecision,
  IFeatureVector17D,
  IMarketDataQualityResult,
  IPositionSizing,
  ISMCConfluenceSetup,
} from '@quant/shared';
import { IOpenPosition, IRiskConfig } from './types';
import { DrawdownGuard, IDrawdownStatus } from './drawdown-guard';
import { PortfolioRiskManager } from './portfolio-risk-manager';

export interface IExecutionSafetyGateParams {
  instrument: string;
  direction: Direction | 'LONG' | 'SHORT' | 'BULLISH' | 'BEARISH';
  mode: 'PAPER' | 'LIVE';
  marketDataQuality: IMarketDataQualityResult;
  smcSetup: ISMCConfluenceSetup;
  featureVector: IFeatureVector17D;
  modelState: {
    status: 'ACTIVE' | 'CANDIDATE' | 'ARCHIVED' | 'DISABLED';
    isDrifted?: boolean;
  };
  prediction: {
    rawProbability: number;
    calibratedProbability: number;
    expectedR: number;
  };
  positionSizing: IPositionSizing;
  accountEquity: number;
  openPositions: IOpenPosition[];
  drawdownStatus?: IDrawdownStatus;
  riskConfig?: IRiskConfig;
  minExpectancyR?: number;
  isSessionActive?: boolean;
}

export class ExecutionSafetyGate {
  /**
   * Evaluates all 12 mandatory quantitative and risk controls before granting order execution.
   */
  public static evaluate(params: IExecutionSafetyGateParams): IExecutionSafetyDecision {
    const checks: Record<string, { passed: boolean; message: string; value?: any }> = {};
    const rejectionReasons: string[] = [];

    const minExpR = params.minExpectancyR ?? 0.2;
    const isBull = String(params.direction).toUpperCase() === 'LONG' || String(params.direction).toUpperCase() === 'BULLISH';

    // 1. Data Quality Check
    const dataPass = params.marketDataQuality?.isValid === true && !params.marketDataQuality.feedDisconnected;
    checks['1_DATA_QUALITY'] = {
      passed: dataPass,
      message: dataPass ? 'Market data quality verified' : `Data quality failed: ${params.marketDataQuality?.reasons?.join(', ') || 'Invalid feed'}`,
      value: params.marketDataQuality?.isValid,
    };
    if (!dataPass) rejectionReasons.push(checks['1_DATA_QUALITY'].message);

    // 2. SMC Setup Confluence Check
    const smcPass = Boolean(
      params.smcSetup &&
      params.smcSetup.risk_reward >= 1.5 &&
      params.smcSetup.stop_loss?.price > 0 &&
      params.smcSetup.entry_zone?.optimal > 0
    );
    checks['2_SMC_SETUP'] = {
      passed: smcPass,
      message: smcPass ? `SMC setup validated (R:R ${params.smcSetup?.risk_reward}R)` : 'Invalid SMC setup geometry or R:R below 1.5',
      value: params.smcSetup?.risk_reward,
    };
    if (!smcPass) rejectionReasons.push(checks['2_SMC_SETUP'].message);

    // 3. 17D Feature Vector Completeness Check
    const fv = params.featureVector;
    const fvKeys: (keyof IFeatureVector17D)[] = [
      'htfTrendAlignment', 'trend4H', 'trend1H', 'structure15M', 'bosChochQuality',
      'orderBlockStrength', 'fvgSize', 'fvgFillPct', 'liquiditySweepDepth',
      'displacementIntensity', 'atrVolatility', 'volumeImbalance', 'cvd',
      'volumeProfilePocProximity', 'sessionKillZone', 'marketRegime', 'smtDivergence'
    ];
    const fvComplete = Boolean(
      fv && fvKeys.every((k) => typeof fv[k] === 'number' && !isNaN(fv[k]) && isFinite(fv[k]))
    );
    checks['3_FEATURE_VECTOR'] = {
      passed: fvComplete,
      message: fvComplete ? '17D Feature Vector complete and sanitized' : 'Feature vector contains NaN, null, or incomplete dimensions',
      value: fvComplete ? 17 : 0,
    };
    if (!fvComplete) rejectionReasons.push(checks['3_FEATURE_VECTOR'].message);

    // 4. Model Health & Governance Check
    const modelHealthy = params.modelState?.status === 'ACTIVE' && !params.modelState.isDrifted;
    checks['4_MODEL_HEALTH'] = {
      passed: modelHealthy,
      message: modelHealthy ? 'Active production model healthy' : `Model unhealthy: status is ${params.modelState?.status}${params.modelState?.isDrifted ? ' (Drift Detected)' : ''}`,
      value: params.modelState?.status,
    };
    if (!modelHealthy) rejectionReasons.push(checks['4_MODEL_HEALTH'].message);

    // 5. Probability Calibration Check
    const calibPass = params.prediction?.calibratedProbability >= 0.50;
    checks['5_PROBABILITY_CALIBRATION'] = {
      passed: calibPass,
      message: calibPass ? `Calibrated win probability ${params.prediction.calibratedProbability.toFixed(3)} >= 0.50` : `Calibrated probability ${(params.prediction?.calibratedProbability || 0).toFixed(3)} is below statistical threshold 0.50`,
      value: params.prediction?.calibratedProbability,
    };
    if (!calibPass) rejectionReasons.push(checks['5_PROBABILITY_CALIBRATION'].message);

    // 6. Mathematical Expectancy Check
    const expPass = (params.prediction?.expectedR || 0) >= minExpR;
    checks['6_EXPECTANCY_R'] = {
      passed: expPass,
      message: expPass ? `Expected value ${params.prediction.expectedR.toFixed(2)}R >= min threshold ${minExpR}R` : `Mathematical expectancy ${params.prediction?.expectedR?.toFixed(2)}R is below minimum threshold ${minExpR}R`,
      value: params.prediction?.expectedR,
    };
    if (!expPass) rejectionReasons.push(checks['6_EXPECTANCY_R'].message);

    // 7. Drawdown Guard & Daily Loss Limit Check
    const ddPass = !params.drawdownStatus || !params.drawdownStatus.isTradingHalted;
    checks['7_DRAWDOWN_GUARD'] = {
      passed: ddPass,
      message: ddPass ? 'Drawdown guard clear' : (params.drawdownStatus?.warningMessage || 'Trading halted due to drawdown limit'),
      value: params.drawdownStatus?.totalDrawdownPercent,
    };
    if (!ddPass) rejectionReasons.push(checks['7_DRAWDOWN_GUARD'].message);

    // 8. Portfolio Exposure & Sector Limits Check
    const portStatus = PortfolioRiskManager.validateNewPosition(
      params.accountEquity,
      params.openPositions || [],
      params.positionSizing,
      params.instrument.includes('BTC') ? 'CRYPTO' : 'EQUITY',
      params.riskConfig || {}
    );
    checks['8_PORTFOLIO_EXPOSURE'] = {
      passed: portStatus.isAllowed,
      message: portStatus.isAllowed ? 'Portfolio risk capacity available' : (portStatus.rejectionReason || 'Portfolio limits breached'),
      value: portStatus.totalOpenRiskPercent,
    };
    if (!portStatus.isAllowed) rejectionReasons.push(checks['8_PORTFOLIO_EXPOSURE'].message);

    // 9. Position Sizing Validation Check
    const sizePass = Boolean(params.positionSizing && params.positionSizing.isValid && params.positionSizing.roundedUnits > 0);
    checks['9_POSITION_SIZING'] = {
      passed: sizePass,
      message: sizePass ? `Position size valid: ${params.positionSizing.roundedUnits} units` : `Position sizing invalid: ${params.positionSizing?.rejectionReason || 'Zero units'}`,
      value: params.positionSizing?.roundedUnits,
    };
    if (!sizePass) rejectionReasons.push(checks['9_POSITION_SIZING'].message);

    // 10. Stop Loss Structural Side Check
    const entryP = params.positionSizing?.entryPrice || params.smcSetup?.entry_zone?.optimal;
    const slP = params.positionSizing?.stopLoss || params.smcSetup?.stop_loss?.price;
    const slSidePass = Boolean(
      entryP > 0 && slP > 0 && (isBull ? slP < entryP : slP > entryP)
    );
    checks['10_STOP_LOSS_STRUCTURE'] = {
      passed: slSidePass,
      message: slSidePass ? 'Stop loss geometry verified on correct side of entry' : `Invalid stop loss geometry: Entry=${entryP}, SL=${slP} for ${isBull ? 'LONG' : 'SHORT'}`,
      value: slP,
    };
    if (!slSidePass) rejectionReasons.push(checks['10_STOP_LOSS_STRUCTURE'].message);

    // 11. Market Session / Trading Hours Check
    const sessionPass = params.isSessionActive !== false;
    checks['11_MARKET_SESSION'] = {
      passed: sessionPass,
      message: sessionPass ? 'Market session is open and active' : 'Market session is closed',
      value: sessionPass,
    };
    if (!sessionPass) rejectionReasons.push(checks['11_MARKET_SESSION'].message);

    // 12. No Conflicting Open Position Check
    const conflicting = (params.openPositions || []).find(
      (p) => p.symbol.toUpperCase() === params.instrument.toUpperCase() && (isBull ? p.direction !== Direction.BULLISH : p.direction !== Direction.BEARISH)
    );
    const noConflictPass = !conflicting;
    checks['12_NO_CONFLICTING_POSITION'] = {
      passed: noConflictPass,
      message: noConflictPass ? 'Zero opposing positions open on instrument' : `Conflicting opposing position already active on ${params.instrument}`,
      value: conflicting?.id,
    };
    if (!noConflictPass) rejectionReasons.push(checks['12_NO_CONFLICTING_POSITION'].message);

    const isApproved = rejectionReasons.length === 0;

    return {
      isApproved,
      mode: params.mode,
      checks,
      rejectionReasons,
      checkedAt: new Date(),
    };
  }
}
