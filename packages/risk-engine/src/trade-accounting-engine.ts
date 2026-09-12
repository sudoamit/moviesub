import {
  buildAccountingSnapshot,
  CurrencyCode,
  Direction,
  IFxConversionResult,
  isLongPosition,
  IResolvedMarginModel,
  ITradeAccountingSnapshot,
  LiquidationModel,
  MarginMode,
} from '@quant/shared';

export interface ITradeMarginCalculation {
  positionNotionalQuote: number;
  positionNotionalAccount: number; // in INR
  initialMarginRequired: number; // in INR
  maintenanceMarginRequired: number; // in INR
  leverage: number;
  marginMode: MarginMode;
  accountingSnapshot?: ITradeAccountingSnapshot;
}

export interface ITradePnlCalculation {
  grossPnlQuote: number;
  grossPnlAccount: number; // in INR
  netPnlAccount: number; // in INR
  realizedR: number;
  fees: number;
  slippage: number;
  accountingSnapshot?: ITradeAccountingSnapshot;
}

export interface ILiquidationCalculationParams {
  entryPrice: number;
  direction: Direction | string;
  leverage?: number;
  marginMode?: MarginMode;
  initialMarginRate?: number;
  maintenanceMarginRate?: number;
  liquidationModel?: LiquidationModel;
  marginModel?: IResolvedMarginModel;
}

export interface ITradePnlParams {
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  direction: Direction | string;
  contractSize?: number;
  quoteCurrency?: CurrencyCode;
  accountCurrency?: CurrencyCode;
  fxRate?: number;
  fees?: number;
  slippage?: number;
  slippageIncludedInPrices?: boolean;
  initialRiskAccount?: number;
  fxSnapshot?: IFxConversionResult;
  accountingSnapshot?: ITradeAccountingSnapshot;
}

export class TradeAccountingEngine {
  /**
   * Calculates notional values in both quote currency and INR account currency.
   * STRICT FAIL-CLOSED: Rejects non-finite, zero, or negative inputs.
   */
  static calculateNotional(
    quantity: number,
    price: number,
    contractSize = 1,
    fxRate = 1.0,
  ): { notionalQuote: number; notionalAccount: number } {
    if (
      typeof quantity !== 'number' ||
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      typeof price !== 'number' ||
      !Number.isFinite(price) ||
      price <= 0 ||
      typeof contractSize !== 'number' ||
      !Number.isFinite(contractSize) ||
      contractSize <= 0 ||
      typeof fxRate !== 'number' ||
      !Number.isFinite(fxRate) ||
      fxRate <= 0
    ) {
      throw new Error(
        `INVALID_NOTIONAL_INPUTS: quantity (${quantity}), price (${price}), contractSize (${contractSize}), fxRate (${fxRate}) must be valid positive finite numbers`,
      );
    }
    const notionalQuote = Number((quantity * price * contractSize).toFixed(4));
    const notionalAccount = Number((notionalQuote * fxRate).toFixed(2));
    return { notionalQuote, notionalAccount };
  }

  /**
   * Authoritatively calculates Initial and Maintenance Margin in INR.
   * Priority:
   * 1. Consumes IResolvedMarginModel if provided
   * 2. SPOT: 100% notional
   * 3. Explicit initialMarginRate if provided (> 0)
   * 4. Leverage-based: notional / leverage
   */
  static calculateMargin(
    notionalAccount: number,
    leverageOrModel?: number | IResolvedMarginModel,
    marginMode: MarginMode = 'ISOLATED',
    initialMarginRate?: number,
    maintenanceMarginRate = 0.05,
  ): { initialMarginRequired: number; maintenanceMarginRequired: number } {
    if (typeof notionalAccount !== 'number' || !Number.isFinite(notionalAccount)) {
      throw new Error(`INVALID_MARGIN_INPUTS: notionalAccount (${notionalAccount}) must be a valid finite number`);
    }

    if (notionalAccount <= 0) {
      return { initialMarginRequired: 0, maintenanceMarginRequired: 0 };
    }

    let lev: number;
    let mMode: MarginMode;
    let imr: number | undefined;
    let mmr: number;

    if (typeof leverageOrModel === 'object' && leverageOrModel !== null) {
      lev = leverageOrModel.effectiveLeverage;
      mMode = leverageOrModel.marginMode;
      imr = leverageOrModel.initialMarginRate;
      mmr = leverageOrModel.maintenanceMarginRate;
    } else {
      lev = leverageOrModel ?? 1;
      mMode = marginMode;
      imr = initialMarginRate;
      mmr = maintenanceMarginRate;
    }

    if (!Number.isFinite(lev) || lev <= 0) {
      throw new Error(`INVALID_MARGIN_INPUTS: leverage (${lev}) must be a positive finite number`);
    }

    if (imr !== undefined && (!Number.isFinite(imr) || imr < 0)) {
      throw new Error(`INVALID_MARGIN_INPUTS: initialMarginRate (${imr}) must be a non-negative finite number`);
    }

    if (mmr !== undefined && (!Number.isFinite(mmr) || mmr < 0)) {
      throw new Error(`INVALID_MARGIN_INPUTS: maintenanceMarginRate (${mmr}) must be a non-negative finite number`);
    }

    let initialMarginRequired: number;

    if (mMode === 'SPOT') {
      initialMarginRequired = notionalAccount;
    } else if (imr !== undefined && imr > 0) {
      initialMarginRequired = notionalAccount * imr;
    } else {
      const effLeverage = Math.max(1, lev);
      initialMarginRequired = notionalAccount / effLeverage;
    }

    const effectiveMmr = Number.isFinite(mmr) ? Math.max(0, mmr) : 0.05;
    const maintenanceMarginRequired = notionalAccount * effectiveMmr;

    return {
      initialMarginRequired: Number(initialMarginRequired.toFixed(2)),
      maintenanceMarginRequired: Number(maintenanceMarginRequired.toFixed(2)),
    };
  }

  /**
   * Calculates model-driven liquidation threshold price.
   * Returns undefined for SPOT or unsupported models.
   */
  static calculateLiquidationPrice(
    paramsOrEntryPrice: ILiquidationCalculationParams | number,
    direction?: Direction | string,
    leverage = 1,
    maintenanceMarginRate = 0.025,
    initialMarginRate?: number,
    liquidationModel?: LiquidationModel,
  ): number | undefined {
    let entryPrice: number;
    let dir: Direction | string;
    let lev: number;
    let mmr: number;
    let imr: number | undefined;
    let model: LiquidationModel | undefined;
    let marginMode: MarginMode | undefined;

    if (typeof paramsOrEntryPrice === 'object') {
      entryPrice = paramsOrEntryPrice.entryPrice;
      dir = paramsOrEntryPrice.direction;
      const mm = paramsOrEntryPrice.marginModel;
      lev = mm?.effectiveLeverage ?? paramsOrEntryPrice.leverage ?? 1;
      mmr = mm?.maintenanceMarginRate ?? paramsOrEntryPrice.maintenanceMarginRate ?? 0.025;
      imr = mm?.initialMarginRate ?? paramsOrEntryPrice.initialMarginRate;
      model = mm?.liquidationModel ?? paramsOrEntryPrice.liquidationModel;
      marginMode = mm?.marginMode ?? paramsOrEntryPrice.marginMode;
    } else {
      entryPrice = paramsOrEntryPrice;
      dir = direction || 'LONG';
      lev = leverage;
      mmr = maintenanceMarginRate;
      imr = initialMarginRate;
      model = liquidationModel;
    }

    if (typeof entryPrice !== 'number' || !Number.isFinite(entryPrice) || entryPrice <= 0) {
      return undefined;
    }
    if (marginMode === 'SPOT' || model === 'SPOT_NONE' || lev <= 1) {
      return undefined; // SPOT / 1x cash positions cannot be liquidated
    }

    // Default to ISOLATED_LINEAR if isolated or not specified
    const effModel = model || 'ISOLATED_LINEAR';
    if (effModel !== 'ISOLATED_LINEAR') {
      return undefined; // Unsupported liquidation model fails closed
    }

    const isLong = isLongPosition(dir as any);
    const effectiveMmr = Number.isFinite(mmr) ? Math.max(0, mmr) : 0.025;
    const marginRatio = imr !== undefined && Number.isFinite(imr) && imr > 0 ? imr : 1.0 / Math.max(1, lev);

    if (isLong) {
      // Long liquidation occurs when price drops below entry * (1 - initialMarginRate + MMR)
      const liq = entryPrice * (1.0 - marginRatio + effectiveMmr);
      return Number(Math.max(0, liq).toFixed(4));
    } else {
      // Short liquidation occurs when price rises above entry * (1 + initialMarginRate - MMR)
      const liq = entryPrice * (1.0 + marginRatio - effectiveMmr);
      return Number(liq.toFixed(4));
    }
  }

  /**
   * Calculates authoritative stop-based risk in INR.
   * INVARIANT: Risk is stop-based and independent of leverage.
   */
  static calculateStopRisk(
    entryPrice: number,
    stopLoss: number,
    quantity: number,
    contractSize = 1,
    fxRate = 1.0,
  ): number {
    if (
      typeof entryPrice !== 'number' ||
      !Number.isFinite(entryPrice) ||
      entryPrice <= 0 ||
      typeof stopLoss !== 'number' ||
      !Number.isFinite(stopLoss) ||
      stopLoss <= 0 ||
      typeof quantity !== 'number' ||
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      typeof contractSize !== 'number' ||
      !Number.isFinite(contractSize) ||
      contractSize <= 0 ||
      typeof fxRate !== 'number' ||
      !Number.isFinite(fxRate) ||
      fxRate <= 0
    ) {
      throw new Error('INVALID_RISK_INPUTS: Inputs to calculateStopRisk must be positive finite numbers');
    }
    const stopDistance = Math.abs(entryPrice - stopLoss);
    const riskQuote = stopDistance * quantity * contractSize;
    const riskAccount = riskQuote * fxRate;
    return Number(riskAccount.toFixed(2));
  }

  /**
   * Calculates gross and net P&L with point-in-time FX conversion.
   * INVARIANT: Changing leverage DOES NOT change fixed-position gross P&L.
   * INVARIANT: Net P&L = gross P&L - explicit fees - unpriced slippage.
   * STRICT FAIL-CLOSED: Cross-currency calculation requires explicit valid fxRate.
   */
  static calculateTradePnl(
    paramsOrEntryPrice: ITradePnlParams | number,
    exitPrice?: number,
    quantity?: number,
    direction?: Direction | string,
    contractSize = 1,
    fxRate?: number,
    fees = 0,
    slippage = 0,
    initialRiskAccount = 0,
    slippageIncludedInPrices = true,
  ): ITradePnlCalculation {
    let pEntry: number;
    let pExit: number;
    let qty: number;
    let dir: Direction | string;
    let cSize: number;
    let fx: number | undefined;
    let feeAmount: number;
    let slipAmount: number;
    let riskAcct: number;
    let slipIncluded: boolean;
    let qCurr: CurrencyCode | undefined;
    let aCurr: CurrencyCode | undefined;
    let acctSnap: ITradeAccountingSnapshot | undefined;

    if (typeof paramsOrEntryPrice === 'object') {
      pEntry = paramsOrEntryPrice.entryPrice;
      pExit = paramsOrEntryPrice.exitPrice;
      qty = paramsOrEntryPrice.quantity;
      dir = paramsOrEntryPrice.direction;
      cSize = paramsOrEntryPrice.contractSize ?? 1;
      qCurr = paramsOrEntryPrice.quoteCurrency ?? paramsOrEntryPrice.accountingSnapshot?.quoteCurrency;
      aCurr = paramsOrEntryPrice.accountCurrency ?? paramsOrEntryPrice.accountingSnapshot?.accountCurrency ?? 'INR';
      fx = paramsOrEntryPrice.fxRate ?? paramsOrEntryPrice.accountingSnapshot?.fxRate ?? paramsOrEntryPrice.fxSnapshot?.fxRate;
      feeAmount = paramsOrEntryPrice.fees ?? 0;
      slipAmount = paramsOrEntryPrice.slippage ?? 0;
      riskAcct = paramsOrEntryPrice.initialRiskAccount ?? 0;
      slipIncluded = paramsOrEntryPrice.slippageIncludedInPrices ?? true;
      acctSnap = paramsOrEntryPrice.accountingSnapshot;

      if (!acctSnap && paramsOrEntryPrice.fxSnapshot) {
        const defaultMarginModel: IResolvedMarginModel = {
          marginMode: 'SPOT',
          effectiveLeverage: 1,
          initialMarginRate: 1.0,
          maintenanceMarginRate: 0.0,
          liquidationModel: 'SPOT_NONE',
        };
        acctSnap = buildAccountingSnapshot({
          accountCurrency: aCurr ?? 'INR',
          quoteCurrency: qCurr ?? (paramsOrEntryPrice.fxSnapshot.fxPair.split('/')[0] as CurrencyCode),
          fxResult: paramsOrEntryPrice.fxSnapshot,
          contractSize: cSize,
          lotSize: qty,
          resolvedMarginModel: defaultMarginModel,
        });
      }
    } else {
      pEntry = paramsOrEntryPrice;
      pExit = exitPrice ?? 0;
      qty = quantity ?? 0;
      dir = direction || 'LONG';
      cSize = contractSize;
      fx = fxRate;
      feeAmount = fees;
      slipAmount = slippage;
      riskAcct = initialRiskAccount;
      slipIncluded = slippageIncludedInPrices;
      aCurr = 'INR';
    }

    if (
      typeof pEntry !== 'number' ||
      !Number.isFinite(pEntry) ||
      typeof pExit !== 'number' ||
      !Number.isFinite(pExit) ||
      typeof qty !== 'number' ||
      !Number.isFinite(qty) ||
      typeof cSize !== 'number' ||
      !Number.isFinite(cSize)
    ) {
      throw new Error('INVALID_PNL_INPUTS: Prices, quantity, and contractSize must be valid finite numbers');
    }

    // Determine FX Rate with Strict Cross-Currency Fail-Closed Rule
    const isCrossCurrency = qCurr && aCurr ? qCurr !== aCurr : false;
    let effectiveFx: number;

    if (isCrossCurrency) {
      if (fx === undefined || typeof fx !== 'number' || !Number.isFinite(fx) || fx <= 0) {
        throw new Error(
          `MISSING_FX_RATE: Explicit positive FX conversion rate is required for cross-currency P&L calculation (${qCurr}/${aCurr})`,
        );
      }
      effectiveFx = fx;
    } else {
      effectiveFx = fx !== undefined ? fx : 1.0;
      if (!Number.isFinite(effectiveFx) || effectiveFx <= 0) {
        throw new Error(`INVALID_FX_RATE: FX rate (${effectiveFx}) must be a positive finite number`);
      }
    }

    const isLong = isLongPosition(dir as any);
    const priceDiff = isLong ? pExit - pEntry : pEntry - pExit;
    const grossPnlQuote = Number((priceDiff * qty * cSize).toFixed(4));
    const grossPnlAccount = Number((grossPnlQuote * effectiveFx).toFixed(2));

    const safeFees = Number.isFinite(feeAmount) ? feeAmount : 0;
    const safeSlippage = Number.isFinite(slipAmount) ? slipAmount : 0;
    const slippageAccountCost = slipIncluded ? 0 : Number((safeSlippage * effectiveFx).toFixed(2));
    const netPnlAccount = Number((grossPnlAccount - safeFees - slippageAccountCost).toFixed(2));

    const effRisk = Math.max(1, riskAcct > 0 && Number.isFinite(riskAcct) ? riskAcct : Math.abs(grossPnlAccount));
    const realizedR = Number((netPnlAccount / effRisk).toFixed(2));

    return {
      grossPnlQuote,
      grossPnlAccount,
      netPnlAccount,
      realizedR,
      fees: safeFees,
      slippage: safeSlippage,
      accountingSnapshot: acctSnap,
    };
  }
}
