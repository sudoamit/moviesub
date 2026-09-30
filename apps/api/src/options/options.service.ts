import { Injectable, Logger, BadRequestException, Optional } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { BlackScholesModel, IndianOptionsExpiryEngine, IExpiryInfo } from '@quant/trading-engine';
import { RealMarketStreamerService } from '../market-data/real-market-streamer.service';
import { MarketDataUnavailableError, StaleMarketDataError, ISmartOptionRecommendation } from '@quant/shared';

export interface IOptionGreekDetails {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}

export interface IOptionContractDetails {
  symbol: string;
  ltp: number;
  change: number;
  changePercent: number;
  oi: number;
  oiChange: number;
  volume: number;
  iv: number;
  intrinsicValue: number;
  timeValue: number;
  delta: number;
  theta: number;
  gamma: number;
  vega: number;
  gex?: number;
  /** EXCHANGE_CHAIN_SCRAPE when the LTP came from the exchange chain, MODEL when Black-Scholes filled it in. */
  ltpSource?: 'EXCHANGE_CHAIN_SCRAPE' | 'MODEL';
}

export interface IOptionStrikeData {
  strikePrice: number;
  isATM: boolean;
  netGex?: number;
  call: IOptionContractDetails;
  put: IOptionContractDetails;
}

export interface IOptionChainResponse {
  symbol: string;
  spotPrice: number;
  atmStrike: number;
  selectedExpiry: string;
  daysToExpiry: number;
  availableExpiries: IExpiryInfo[];
  pcr: number;
  maxPain: number;
  gammaFlipLevel?: number;
  netGammaExposure?: number;
  totalCallOI: number;
  totalPutOI: number;
  expectedWeeklyMovePts: number;
  expectedRange: { lower: number; upper: number };
  lotSize: number;
  strikes: IOptionStrikeData[];
}

export { ISmartOptionRecommendation };

@Injectable()
export class OptionsService {
  private readonly logger = new Logger(OptionsService.name);
  private liveChainCache: Map<string, { timestamp: number; data: any[] }> = new Map();
  private static readonly MAX_STALE_CHAIN_MS = 30_000;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly realMarketStreamer?: RealMarketStreamerService,
  ) {}

  /**
   * Normalizes exchange option strikes from API feeds.
   * If rawStrike is in paise (>= 500,000, e.g. Groww API 2420000 -> 24200), converts to rupees.
   * If rawStrike is already in rupees (e.g. 24200), NEVER divides by 100!
   */
  public normalizeExchangeStrike(rawStrike: number): number {
    if (!rawStrike || Number.isNaN(rawStrike)) return 0;
    if (rawStrike >= 500000) {
      return Math.round(rawStrike / 100);
    }
    return Math.round(rawStrike);
  }

  /**
   * Obtains authoritative live current market spot for options chain and valuation.
   * Strictly prioritizes live market data provider.
   * Prohibits hardcoded production fallbacks (e.g. 24007.35).
   */
  public async getAuthoritativeCurrentSpot(
    symbol: string,
    explicitSpot?: number,
  ): Promise<number> {
    const sym = symbol.toUpperCase();
    const hasExplicitSpot = Boolean(explicitSpot && Number.isFinite(explicitSpot) && explicitSpot > 0);

    // 1. Authoritative live market streamer service (always wins over any client-supplied spot)
    if (this.realMarketStreamer) {
      try {
        const snap = this.realMarketStreamer.getAuthoritativeSnapshot(sym);
        if (snap) {
          if (snap.isFresh === false) {
            const eventTime = snap.marketEventTime ? new Date(snap.marketEventTime) : new Date();
            const ageSec = Math.max(0, (Date.now() - eventTime.getTime()) / 1000);
            throw new StaleMarketDataError(sym, ageSec, 5, eventTime);
          }
          if (snap.price > 0) {
            return snap.price;
          }
        }
      } catch (err: any) {
        if (err instanceof StaleMarketDataError) {
          throw err;
        }
        // Fall through to check validated ticker
      }

      try {
        const ticker = this.realMarketStreamer.getValidatedTicker(sym, 10);
        if (ticker && ticker.price > 0) {
          return ticker.price;
        }
      } catch (err: any) {
        if (err instanceof StaleMarketDataError || err instanceof MarketDataUnavailableError) {
          throw err;
        }
      }
    }

    // 2. A client-supplied spot is never authoritative: it is accepted only in the test environment when
    //    no live quote exists (otherwise a strategy trigger could be passed off as the current spot).
    if (process.env.NODE_ENV === 'test' && hasExplicitSpot) {
      return explicitSpot as number;
    }

    // 3. Fallback to latest database candle only if test/dev mode
    if (process.env.NODE_ENV === 'test' && this.prisma?.instrument) {
      const inst = await this.prisma.instrument.findUnique({ where: { symbol: sym } });
      if (inst && this.prisma?.candle) {
        const latestCandle = await this.prisma.candle.findFirst({
          where: { instrumentId: inst.id },
          orderBy: { timestamp: 'desc' },
        });
        if (latestCandle && Number(latestCandle.close) > 0) {
          return Number(latestCandle.close);
        }
      }
    }

    // 4. In live execution/production, missing live spot must throw fail-closed error
    throw new MarketDataUnavailableError(
      sym,
      `No live exchange market data available for ${sym} options valuation. Hardcoded fallback prices are strictly prohibited.`,
    );
  }

  /**
   * Fetches real-time live Option Chain directly from NSE Exchange API with 2-second in-memory cache
   */
  private async fetchLiveNSEChain(symbol: string): Promise<any[]> {
    const sym = symbol.toUpperCase();
    if (sym !== 'NIFTY' && sym !== 'BANKNIFTY') return [];
    // Unit tests must be deterministic: never scrape the live exchange chain under test.
    if (process.env.NODE_ENV === 'test') return [];

    const cached = this.liveChainCache.get(sym);
    if (cached && Date.now() - cached.timestamp < 2000) {
      return cached.data;
    }

    try {
      const growwSym = sym === 'NIFTY' ? 'nifty' : 'nifty-bank';
      const res = await fetch(
        `https://groww.in/v1/api/option_chain_service/v1/option_chain/${growwSym}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            Accept: 'application/json',
          },
        },
      );

      if (res.ok) {
        const json = await res.json();
        const rawChains = json?.optionChain?.optionChains || [];
        this.liveChainCache.set(sym, { timestamp: Date.now(), data: rawChains });
        return rawChains;
      }
    } catch (err) {
      this.logger.debug(`Live NSE options fetch notice: ${(err as Error).message}`);
    }

    // A failed refresh may reuse the previous chain only while it is still recent; never serve it indefinitely.
    if (cached && Date.now() - cached.timestamp < OptionsService.MAX_STALE_CHAIN_MS) {
      return cached.data;
    }
    return [];
  }

  /**
   * Generates Option Chain using direct Real-Time Live NSE Quotes with Black-Scholes Greeks fallback
   */
  async getOptionChain(
    symbol: string = 'NIFTY',
    targetExpiryDate?: string,
    spotPriceOverride?: number,
    requestedStrike?: number,
  ): Promise<IOptionChainResponse> {
    const sym = symbol.toUpperCase();
    const inst = this.prisma?.instrument
      ? await this.prisma.instrument.findUnique({ where: { symbol: sym } })
      : null;

    // Fetch latest candle for reference if available
    const latestCandle =
      inst && this.prisma?.candle
        ? await this.prisma.candle.findFirst({
            where: { instrumentId: inst.id },
            orderBy: { timestamp: 'desc' },
          })
        : null;

    // Authoritative spot price: strictly from live provider or explicit parameter
    const spotPrice = await this.getAuthoritativeCurrentSpot(sym, spotPriceOverride);

    if (!spotPrice || spotPrice <= 0) {
      throw new BadRequestException(
        `No live exchange market data available for ${sym} options chain. Hardcoded BTC prices are prohibited.`,
      );
    }

    const step =
      sym === 'BTCUSDT'
        ? 500
        : sym === 'XAUUSD' || sym === 'GOLD'
          ? 10
          : sym === 'BANKNIFTY'
            ? 100
            : sym === 'RELIANCE'
              ? 20
              : sym === 'HDFCBANK'
                ? 10
                : sym === 'INFY'
                  ? 20
                  : 50;

    const atmStrike = Math.round(spotPrice / step) * step;

    // 1. Calculate authentic Exchange Expiry Dates
    const expiries = IndianOptionsExpiryEngine.getUpcomingExpiries(sym);
    const selectedExpiryInfo =
      expiries.find((e) => e.dateString === targetExpiryDate) || expiries[0];

    const timeToExpiryYears = selectedExpiryInfo.timeToExpiryYears;
    const daysToExpiry = selectedExpiryInfo.daysToExpiry;

    // Lot Size Mapping
    const lotSize =
      sym === 'NIFTY'
        ? 65
        : sym === 'BANKNIFTY'
          ? 15
          : sym === 'FINNIFTY'
            ? 40
            : sym === 'BTCUSDT' || sym === 'XAUUSD' || sym === 'GOLD'
              ? 1
              : sym === 'RELIANCE'
                ? 250
                : sym === 'HDFCBANK'
                  ? 550
                  : sym === 'INFY'
                    ? 400
                    : 100;

    const rawExchangeChains = await this.fetchLiveNSEChain(sym);
    const strikes: IOptionStrikeData[] = [];
    let totalCallOI = 0;
    let totalPutOI = 0;

    // Asset-specific annualized base IV
    const baseIV =
      sym === 'BTCUSDT'
        ? 0.52
        : sym === 'XAUUSD' || sym === 'GOLD'
          ? 0.14
          : sym === 'BANKNIFTY'
            ? 0.125
            : sym === 'RELIANCE'
              ? 0.18
              : sym === 'HDFCBANK'
                ? 0.16
                : sym === 'INFY'
                  ? 0.19
                  : 0.098;

    // Generate strike set: 7 below ATM, ATM, 7 above ATM, plus any explicitly requested strike
    const strikeSet = new Set<number>();
    for (let i = -7; i <= 7; i++) {
      strikeSet.add(atmStrike + i * step);
    }
    if (requestedStrike && requestedStrike > 0) {
      strikeSet.add(requestedStrike);
    }
    const sortedStrikes = Array.from(strikeSet).sort((a, b) => a - b);

    // Estimate current live spot price from raw exchange chain (where call and put prices are closest)
    let exchangeImpliedSpot: number | null = null;
    if (rawExchangeChains && rawExchangeChains.length > 0) {
      let minDiff = Infinity;
      for (const c of rawExchangeChains) {
        const cLtp = c.callOption?.ltp;
        const pLtp = c.putOption?.ltp;
        if (cLtp && pLtp && cLtp > 0 && pLtp > 0) {
          const diff = Math.abs(cLtp - pLtp);
          if (diff < minDiff) {
            minDiff = diff;
            const normStrike = this.normalizeExchangeStrike(c.strikePrice);
            // Mathematically valid Put-Call parity inference: S ≈ K + (C - P)
            exchangeImpliedSpot = normStrike + (cLtp - pLtp);
          }
        }
      }
    }

    const referenceCurrentSpot =
      exchangeImpliedSpot || (latestCandle ? Number(latestCandle.close) : null);

    const spotDiffersFromExchange = Boolean(
      exchangeImpliedSpot && Math.abs(spotPrice - exchangeImpliedSpot) > 40,
    );

    // If spotPrice differs from current exchange spot, live exchange quotes (from current spot) do not apply.
    const isHistoricalSpotOverride = Boolean(
      (spotPriceOverride &&
        spotPriceOverride > 0 &&
        referenceCurrentSpot &&
        Math.abs(spotPriceOverride - referenceCurrentSpot) > 40) ||
        spotDiffersFromExchange,
    );

    for (const strikePrice of sortedStrikes) {
      const i = Math.round((strikePrice - atmStrike) / step);
      const isATM = strikePrice === atmStrike;

      // Check for live matching exchange contract using normalized strike (in rupees)
      const exchangeContract = rawExchangeChains.find(
        (c) => this.normalizeExchangeStrike(c.strikePrice) === strikePrice,
      );

      let callLtp = exchangeContract?.callOption?.ltp;
      let putLtp = exchangeContract?.putOption?.ltp;
      const callOi = exchangeContract?.callOption?.openInterest || 0;
      const putOi = exchangeContract?.putOption?.openInterest || 0;
      const callVol = exchangeContract?.callOption?.volume || 0;
      const putVol = exchangeContract?.putOption?.volume || 0;
      const callChange = exchangeContract?.callOption?.dayChange || 0;
      const putChange = exchangeContract?.putOption?.dayChange || 0;
      const callChangePerc = exchangeContract?.callOption?.dayChangePerc || 0;
      const putChangePerc = exchangeContract?.putOption?.dayChangePerc || 0;

      // Realistic Volatility Skew
      const callIV = baseIV + Math.max(0, -i) * 0.001 + Math.max(0, i) * 0.0022;
      const putIV = baseIV + Math.max(0, -i) * 0.002 + Math.max(0, i) * 0.001;

      // Exact Black-Scholes Greeks Calculation at target spotPrice
      const bsCall = BlackScholesModel.calculate(
        spotPrice,
        strikePrice,
        timeToExpiryYears,
        0.07,
        callIV,
        'CE',
      );
      const bsPut = BlackScholesModel.calculate(
        spotPrice,
        strikePrice,
        timeToExpiryYears,
        0.07,
        putIV,
        'PE',
      );

      // Sanity guard: an ATM / near-money contract on NIFTY/BANKNIFTY with daysToExpiry >= 1 cannot be < 10 rupees.
      // Deep OTM quotes from external scrapers at a divergent spot must never contaminate target spot pricing.
      const isNearMoney = Math.abs(strikePrice - spotPrice) <= 100;
      const isCallUnphysical = isNearMoney && daysToExpiry >= 1 && callLtp !== undefined && callLtp < 10.0;
      const isPutUnphysical = isNearMoney && daysToExpiry >= 1 && putLtp !== undefined && putLtp < 10.0;

      // Sourced from live exchange only when matching current spot price and physically valid, otherwise use Black-Scholes price
      const callFromExchange = Boolean(!isHistoricalSpotOverride && !isCallUnphysical && callLtp && callLtp > 0);
      const putFromExchange = Boolean(!isHistoricalSpotOverride && !isPutUnphysical && putLtp && putLtp > 0);
      const finalCallLtp = callFromExchange ? Number(callLtp.toFixed(2)) : bsCall.price;
      const finalPutLtp = putFromExchange ? Number(putLtp.toFixed(2)) : bsPut.price;

      const callEffectiveOI =
        callOi > 0 ? callOi : Math.round((45000 - Math.abs(i) * 3200) / lotSize) * lotSize;
      const putEffectiveOI =
        putOi > 0 ? putOi : Math.round((48000 - Math.abs(i) * 3200) / lotSize) * lotSize;

      totalCallOI += callEffectiveOI;
      totalPutOI += putEffectiveOI;

      const callIntrinsic = Math.max(0, spotPrice - strikePrice);
      const putIntrinsic = Math.max(0, strikePrice - spotPrice);

      // Strike Gamma Exposure (GEX in ₹ Cr)
      const callGex = Number(
        ((bsCall.greeks.gamma * callEffectiveOI * spotPrice ** 2 * 0.01) / 10000000).toFixed(2),
      );
      const putGex = Number(
        ((-bsPut.greeks.gamma * putEffectiveOI * spotPrice ** 2 * 0.01) / 10000000).toFixed(2),
      );
      const netStrikeGex = Number((callGex + putGex).toFixed(2));

      strikes.push({
        strikePrice,
        isATM,
        netGex: netStrikeGex,
        call: {
          symbol: `${sym} ${strikePrice} CE`,
          ltp: finalCallLtp,
          ltpSource: callFromExchange ? 'EXCHANGE_CHAIN_SCRAPE' : 'MODEL',
          change: Number(callChange.toFixed(2)),
          changePercent: Number(callChangePerc.toFixed(2)),
          oi: callEffectiveOI,
          oiChange:
            exchangeContract?.callOption?.oiChange ||
            Math.round(callEffectiveOI * 0.08 * (i >= 0 ? 1 : -0.5)),
          volume: callVol > 0 ? callVol : Math.round(callEffectiveOI * 1.8),
          iv: bsCall.iv,
          intrinsicValue: Number(callIntrinsic.toFixed(2)),
          timeValue: Number(Math.max(0.05, finalCallLtp - callIntrinsic).toFixed(2)),
          delta: bsCall.greeks.delta,
          theta: bsCall.greeks.theta,
          gamma: bsCall.greeks.gamma,
          vega: bsCall.greeks.vega,
          gex: callGex,
        },
        put: {
          symbol: `${sym} ${strikePrice} PE`,
          ltp: finalPutLtp,
          ltpSource: putFromExchange ? 'EXCHANGE_CHAIN_SCRAPE' : 'MODEL',
          change: Number(putChange.toFixed(2)),
          changePercent: Number(putChangePerc.toFixed(2)),
          oi: putEffectiveOI,
          oiChange:
            exchangeContract?.putOption?.oiChange ||
            Math.round(putEffectiveOI * 0.08 * (i <= 0 ? 1 : -0.5)),
          volume: putVol > 0 ? putVol : Math.round(putEffectiveOI * 1.8),
          iv: bsPut.iv,
          intrinsicValue: Number(putIntrinsic.toFixed(2)),
          timeValue: Number(Math.max(0.05, finalPutLtp - putIntrinsic).toFixed(2)),
          delta: bsPut.greeks.delta,
          theta: bsPut.greeks.theta,
          gamma: bsPut.greeks.gamma,
          vega: bsPut.greeks.vega,
          gex: putGex,
        },
      });
    }

    // 2. Put-Call Ratio
    const pcr = totalCallOI > 0 ? Number((totalPutOI / totalCallOI).toFixed(2)) : 1.0;

    // 3. Exact Max Pain Calculation
    let minPain = Infinity;
    let maxPainStrike = atmStrike;

    for (const testStrike of strikes) {
      let pain = 0;
      for (const row of strikes) {
        const callLoss = Math.max(0, testStrike.strikePrice - row.strikePrice) * row.call.oi;
        const putLoss = Math.max(0, row.strikePrice - testStrike.strikePrice) * row.put.oi;
        pain += callLoss + putLoss;
      }
      if (pain < minPain) {
        minPain = pain;
        maxPainStrike = testStrike.strikePrice;
      }
    }

    // 4. Gamma Flip Level & Total Net GEX Calculation
    let netGammaExposure = 0;
    let gammaFlipStrike = atmStrike;
    let minGexDistance = Infinity;

    for (const s of strikes) {
      netGammaExposure += (s as any).netGex || 0;
      if (Math.abs((s as any).netGex || 0) < minGexDistance) {
        minGexDistance = Math.abs((s as any).netGex || 0);
        gammaFlipStrike = s.strikePrice;
      }
    }
    netGammaExposure = Number(netGammaExposure.toFixed(2));

    // 5. Expected Weekly Move
    const atmData = strikes.find((s) => s.isATM) || strikes[7];
    const expectedWeeklyMovePts = atmData
      ? Number((atmData.call.ltp + atmData.put.ltp).toFixed(1))
      : 120;
    const expectedRange = {
      lower: Number((spotPrice - expectedWeeklyMovePts).toFixed(2)),
      upper: Number((spotPrice + expectedWeeklyMovePts).toFixed(2)),
    };

    return {
      symbol: sym,
      spotPrice,
      atmStrike,
      selectedExpiry: selectedExpiryInfo.dateString,
      daysToExpiry,
      availableExpiries: expiries,
      pcr,
      maxPain: maxPainStrike,
      gammaFlipLevel: gammaFlipStrike,
      netGammaExposure,
      totalCallOI,
      totalPutOI,
      expectedWeeklyMovePts,
      expectedRange,
      lotSize,
      strikes,
    };
  }

  async getSmartOptionRecommendation(
    symbol: string,
    direction: 'BULLISH' | 'BEARISH',
    spotTarget?: number,
    spotStopLoss?: number,
    targetExpiryDate?: string,
    spotPriceOverride?: number,
    strikeOverride?: number,
  ): Promise<ISmartOptionRecommendation> {
    return this.getSmartStrikeRecommendation(
      symbol,
      direction,
      spotTarget,
      spotStopLoss,
      targetExpiryDate,
      spotPriceOverride,
      strikeOverride,
    );
  }

  async getSmartStrikeRecommendation(
    symbolOrParams:
      | string
      | {
          symbol: string;
          direction: 'BULLISH' | 'BEARISH';
          spotTarget?: number;
          spotStopLoss?: number;
          targetExpiryDate?: string;
          currentSpotPrice?: number;
          underlyingTriggerPrice?: number;
          spotPriceOverride?: number;
          strikeOverride?: number;
          triggerMode?: 'OPTION_PREMIUM' | 'UNDERLYING_SPOT';
        },
    maybeDirection?: 'BULLISH' | 'BEARISH',
    maybeSpotTarget?: number,
    maybeSpotStopLoss?: number,
    maybeTargetExpiryDate?: string,
    maybeSpotPriceOverride?: number,
    maybeStrikeOverride?: number,
    maybeUnderlyingTriggerPrice?: number,
    maybeTriggerMode?: 'OPTION_PREMIUM' | 'UNDERLYING_SPOT',
  ): Promise<ISmartOptionRecommendation> {
    let symbol: string;
    let direction: 'BULLISH' | 'BEARISH';
    let spotTarget: number | undefined;
    let spotStopLoss: number | undefined;
    let targetExpiryDate: string | undefined;
    let currentSpotPriceInput: number | undefined;
    let underlyingTriggerPriceInput: number | undefined;
    let strikeOverride: number | undefined;
    let triggerMode: 'OPTION_PREMIUM' | 'UNDERLYING_SPOT' | undefined;

    if (typeof symbolOrParams === 'object' && symbolOrParams !== null) {
      symbol = symbolOrParams.symbol;
      direction = symbolOrParams.direction;
      spotTarget = symbolOrParams.spotTarget;
      spotStopLoss = symbolOrParams.spotStopLoss;
      targetExpiryDate = symbolOrParams.targetExpiryDate;
      currentSpotPriceInput = symbolOrParams.currentSpotPrice ?? symbolOrParams.spotPriceOverride;
      underlyingTriggerPriceInput = symbolOrParams.underlyingTriggerPrice;
      strikeOverride = symbolOrParams.strikeOverride;
      triggerMode = symbolOrParams.triggerMode;
    } else {
      symbol = symbolOrParams;
      direction = maybeDirection || 'BULLISH';
      spotTarget = maybeSpotTarget;
      spotStopLoss = maybeSpotStopLoss;
      targetExpiryDate = maybeTargetExpiryDate;
      currentSpotPriceInput = maybeSpotPriceOverride;
      strikeOverride = maybeStrikeOverride;
      underlyingTriggerPriceInput = maybeUnderlyingTriggerPrice;
      triggerMode = maybeTriggerMode;
    }

    // 1. Authoritative Current Spot Price (strictly from live provider or explicit input)
    const currentSpotPrice = await this.getAuthoritativeCurrentSpot(symbol, currentSpotPriceInput);

    // 2. Underlying Trigger Price (distinct from current live spot). Without a strategy trigger the setup
    //    is valued at the current spot for display only and can never become READY.
    const triggerProvided = Boolean(
      underlyingTriggerPriceInput && Number.isFinite(underlyingTriggerPriceInput) && underlyingTriggerPriceInput > 0,
    );
    const underlyingTriggerPrice = triggerProvided ? (underlyingTriggerPriceInput as number) : currentSpotPrice;

    const isBull = direction === 'BULLISH';
    const optType: 'CE' | 'PE' = isBull ? 'CE' : 'PE';

    // 4. Generate option chain strictly grounded in currentSpotPrice
    const chain = await this.getOptionChain(
      symbol,
      targetExpiryDate,
      currentSpotPrice,
      strikeOverride,
    );

    // Find requested strike or default to ATM
    let selectedStrike = strikeOverride
      ? chain.strikes.find((s) => s.strikePrice === strikeOverride) ||
        chain.strikes.find((s) => s.isATM) ||
        chain.strikes[0]
      : chain.strikes.find((s) => s.isATM) || chain.strikes[0];
    const contract = isBull ? selectedStrike.call : selectedStrike.put;

    // Current Option LTP at current market spot
    const currentOptionLtp = contract.ltp;
    const contractSymbolForFeed = `${chain.symbol} ${selectedStrike.strikePrice} ${optType}`;

    // Planned Option Entry Premium at trigger scenario
    let plannedEntryPremium = currentOptionLtp;
    if (Math.abs(underlyingTriggerPrice - currentSpotPrice) > 0.05) {
      const bsAtTrigger = BlackScholesModel.calculateOptionPremiumAtTrigger(
        underlyingTriggerPrice,
        selectedStrike.strikePrice,
        chain.daysToExpiry / 365,
        0.07,
        contract.iv / 100,
        optType,
      );
      plannedEntryPremium = bsAtTrigger.price;
    }

    // NOTE: this service must never publish into the execution quote feed. The chart premium here may be a
    // Black-Scholes model value or a cached scrape; stamping it with Date.now() would let an order fill at a
    // model price labelled as a live exchange quote. Live option quotes are published only by
    // RealMarketStreamerService.fetchRealNseOptionQuotes, with the exchange's real last-trade time.

    // Execution eligibility: the order boundary fills only against a live option quote from the execution
    // feed. A scraped or modelled premium is display-only, so without that feed the setup is NOT ELIGIBLE.
    const liveOptionTicker =
      this.realMarketStreamer &&
      typeof this.realMarketStreamer.getOptionTicker === 'function'
        ? this.realMarketStreamer.getOptionTicker(contractSymbolForFeed)
        : null;
    const hasLiveOptionQuote = Boolean(liveOptionTicker);
    const effectiveOptionLtp =
      hasLiveOptionQuote && liveOptionTicker?.price ? liveOptionTicker.price : currentOptionLtp;

    // Trigger Condition Evaluation
    const isOptionPremiumTrigger = triggerMode === 'OPTION_PREMIUM';
    const triggerConditionSatisfied =
      triggerProvided &&
      (isOptionPremiumTrigger
        ? plannedEntryPremium > 0 &&
          effectiveOptionLtp > 0 &&
          Math.abs(effectiveOptionLtp - plannedEntryPremium) / plannedEntryPremium <= 0.01
        : isBull
          ? currentSpotPrice >= underlyingTriggerPrice
          : currentSpotPrice <= underlyingTriggerPrice);

    const distanceToTrigger = isOptionPremiumTrigger
      ? Number(Math.abs(effectiveOptionLtp - plannedEntryPremium).toFixed(2))
      : Number(Math.abs(underlyingTriggerPrice - currentSpotPrice).toFixed(2));

    const ineligibilityReasons: string[] = [];
    if (!hasLiveOptionQuote) {
      ineligibilityReasons.push(
        `NO_LIVE_OPTION_QUOTE: no live execution-feed quote for ${contractSymbolForFeed}; displayed premium is ${contract.ltpSource === 'MODEL' ? 'model-derived' : 'from a scraped chain'}.`,
      );
    }
    const executionEligible = ineligibilityReasons.length === 0;
    const premiumSource: 'LIVE_EXECUTION_FEED' | 'EXCHANGE_CHAIN_SCRAPE' | 'MODEL' = hasLiveOptionQuote
      ? 'LIVE_EXECUTION_FEED'
      : (contract.ltpSource ?? 'MODEL');
    const status: ISmartOptionRecommendation['status'] = !triggerProvided
      ? 'NO_TRIGGER'
      : !triggerConditionSatisfied
        ? 'WAITING_FOR_TRIGGER'
        : executionEligible
          ? 'READY_FOR_EXECUTION'
          : 'NOT_ELIGIBLE';

    // Planned Option Stop Premium
    const optDelta = Math.abs(contract.delta);
    const spotMoveToSL = spotStopLoss
      ? Math.abs(underlyingTriggerPrice - spotStopLoss)
      : underlyingTriggerPrice * 0.004;
    const optionRiskMove = spotMoveToSL * optDelta;
    const maxOptionRiskPts =
      chain.symbol === 'NIFTY' ? 25.0 : chain.symbol === 'BANKNIFTY' ? 60.0 : 25.0;
    const calculatedRiskPts = Math.min(
      maxOptionRiskPts,
      Math.max(15.0, optionRiskMove > 0 ? optionRiskMove : 20.0),
    );

    const plannedStopPremium = Math.max(1.0, Number((plannedEntryPremium - calculatedRiskPts).toFixed(2)));
    const optionRiskDistance = Number(Math.abs(plannedEntryPremium - plannedStopPremium).toFixed(2));

    const rr1 = 1.5;
    const rr2 = 2.5;
    const rr3 = 4.0;
    const maxPotentialR = 4.0;
    const primaryTargetR = 2.5;

    const optionTarget1 = Number((plannedEntryPremium + optionRiskDistance * rr1).toFixed(2));
    const optionTarget2 = Number((plannedEntryPremium + optionRiskDistance * rr2).toFixed(2));
    const optionTarget3 = Number((plannedEntryPremium + optionRiskDistance * rr3).toFixed(2));

    const riskPerLot = Number((optionRiskDistance * chain.lotSize).toFixed(2));
    const premiumOutlayPerLot = Number((plannedEntryPremium * chain.lotSize).toFixed(2));
    const profitPerLot = Number(((optionTarget1 - plannedEntryPremium) * chain.lotSize).toFixed(2));
    const roi = Number(((profitPerLot / (premiumOutlayPerLot || 1)) * 100).toFixed(1));

    const expiryLabel =
      chain.availableExpiries.find((e) => e.dateString === chain.selectedExpiry)?.formattedLabel ||
      chain.selectedExpiry;
    const contractName = `${chain.symbol} ${selectedStrike.strikePrice} ${optType}`;

    return {
      underlyingSymbol: chain.symbol,
      direction,

      // Explicit separated spot vs trigger prices
      currentSpotPrice,
      underlyingTriggerPrice,
      distanceToTrigger,
      triggerConditionSatisfied,
      triggerProvided,
      executionEligible,
      ineligibilityReasons,
      premiumSource,
      status,

      // Option contract specification
      optionContract: {
        symbol: contractName,
        strike: selectedStrike.strikePrice,
        optionType: optType,
        expiry: expiryLabel,
        lotSize: chain.lotSize,
      },

      // Explicit separated option premiums
      currentOptionLtp,
      plannedEntryPremium,
      plannedStopPremium,
      targets: {
        tp1: optionTarget1,
        tp2: optionTarget2,
        tp3: optionTarget3,
      },

      // Risk and Reward metrics
      riskPerUnit: optionRiskDistance,
      riskAmountPerLot: riskPerLot,
      premiumOutlayPerLot,
      expectedProfitPerLot: profitPerLot,
      roiPercent: roi,
      rr1,
      rr2,
      rr3,
      maxPotentialR,
      primaryTargetR,

      // Greeks & Context
      delta: contract.delta,
      theta: contract.theta,
      iv: contract.iv,
      isATM: selectedStrike.isATM,
      daysToExpiry: chain.daysToExpiry,
      expiryLabel,

      // Backward compatibility aliases
      spotPrice: currentSpotPrice,
      recommendedStrike: selectedStrike.strikePrice,
      optionType: optType,
      contractName,
      optionLtp: currentOptionLtp,
      optionStopLoss: plannedStopPremium,
      optionTarget1,
      optionTarget2,
      optionTarget3,
      lotSize: chain.lotSize,
    };
  }
}
