import { BlackScholesModel } from '@quant/trading-engine';

/** One strike of an option chain (call and put side). */
export interface ChainStrike {
  strike: number;
  call?: { ltp: number; oi: number; prevOi: number; volume: number };
  put?: { ltp: number; oi: number; prevOi: number; volume: number };
}

export interface OptionChainMetrics {
  /** Put/call ratio of open interest (all strikes) */
  pcrOi: number;
  /** Put/call ratio of traded volume */
  pcrVolume: number | null;
  totalCallOi: number;
  totalPutOi: number;
  /** Change of open interest since the previous session (writers adding / covering) */
  callOiChange: number;
  putOiChange: number;
  /** Strike at which option buyers lose the most (sellers' pain is lowest) */
  maxPain: number;
  maxPainDistPct: number;
  /** Largest call OI above spot (resistance) / put OI below spot (support) */
  callWall: number;
  putWall: number;
  callWallDistPct: number;
  putWallDistPct: number;
  atmStrike: number;
  /** Implied volatility at the money (annualised, e.g. 0.12 = 12%), solved from option prices */
  atmIv: number | null;
  /** OTM put IV minus OTM call IV (~2% away): fear premium */
  ivSkew: number | null;
  daysToExpiry: number;
}

const RISK_FREE = 0.065;

/** Implied volatility by bisection; null when the price is outside the no-arbitrage range. */
export function impliedVolatility(price: number, spot: number, strike: number, years: number, type: 'CE' | 'PE'): number | null {
  if (!(price > 0) || !(spot > 0) || !(strike > 0) || !(years > 0)) return null;
  const at = (v: number) => BlackScholesModel.calculate(spot, strike, years, RISK_FREE, v, type).price;
  let lo = 0.01, hi = 3;
  if (price < at(lo) - 0.05 || price > at(hi)) return null;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (at(mid) > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Summarises an option chain for one expiry. `expiryCloseMs` is the expiry's settlement time (15:30 IST).
 */
export function summarizeOptionChain(rows: ChainStrike[], spot: number, expiryCloseMs: number, nowMs: number): OptionChainMetrics | null {
  const strikes = rows.filter((r) => r.strike > 0).sort((a, b) => a.strike - b.strike);
  if (strikes.length < 5 || !(spot > 0)) return null;
  const sum = (f: (r: ChainStrike) => number) => strikes.reduce((a, r) => a + (f(r) || 0), 0);
  const totalCallOi = sum((r) => r.call?.oi ?? 0);
  const totalPutOi = sum((r) => r.put?.oi ?? 0);
  if (!(totalCallOi > 0) || !(totalPutOi > 0)) return null;
  const callVol = sum((r) => r.call?.volume ?? 0);
  const putVol = sum((r) => r.put?.volume ?? 0);

  // Max pain: strike minimising the total intrinsic value paid to option holders at expiry
  let maxPain = strikes[0].strike, minPain = Infinity;
  for (const k of strikes) {
    const pain = strikes.reduce(
      (a, s) => a + (s.call?.oi ?? 0) * Math.max(0, k.strike - s.strike) + (s.put?.oi ?? 0) * Math.max(0, s.strike - k.strike),
      0,
    );
    if (pain < minPain) { minPain = pain; maxPain = k.strike; }
  }
  const above = strikes.filter((s) => s.strike >= spot);
  const below = strikes.filter((s) => s.strike <= spot);
  const callWall = (above.length ? above : strikes).reduce((a, s) => ((s.call?.oi ?? 0) > (a.call?.oi ?? 0) ? s : a)).strike;
  const putWall = (below.length ? below : strikes).reduce((a, s) => ((s.put?.oi ?? 0) > (a.put?.oi ?? 0) ? s : a)).strike;

  const years = Math.max(1 / (365 * 24), (expiryCloseMs - nowMs) / (365 * 86_400_000));
  const nearest = (target: number) => strikes.reduce((a, s) => (Math.abs(s.strike - target) < Math.abs(a.strike - target) ? s : a));
  const atm = nearest(spot);
  const ivs = [
    atm.call ? impliedVolatility(atm.call.ltp, spot, atm.strike, years, 'CE') : null,
    atm.put ? impliedVolatility(atm.put.ltp, spot, atm.strike, years, 'PE') : null,
  ].filter((v): v is number => v !== null);
  const otmPut = nearest(spot * 0.98), otmCall = nearest(spot * 1.02);
  const putIv = otmPut.put ? impliedVolatility(otmPut.put.ltp, spot, otmPut.strike, years, 'PE') : null;
  const callIv = otmCall.call ? impliedVolatility(otmCall.call.ltp, spot, otmCall.strike, years, 'CE') : null;

  return {
    pcrOi: totalPutOi / totalCallOi,
    pcrVolume: callVol > 0 ? putVol / callVol : null,
    totalCallOi,
    totalPutOi,
    callOiChange: sum((r) => (r.call ? r.call.oi - r.call.prevOi : 0)),
    putOiChange: sum((r) => (r.put ? r.put.oi - r.put.prevOi : 0)),
    maxPain,
    maxPainDistPct: ((maxPain - spot) / spot) * 100,
    callWall,
    putWall,
    callWallDistPct: ((callWall - spot) / spot) * 100,
    putWallDistPct: ((putWall - spot) / spot) * 100,
    atmStrike: atm.strike,
    atmIv: ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null,
    ivSkew: putIv !== null && callIv !== null ? putIv - callIv : null,
    daysToExpiry: years * 365,
  };
}

/** Groww option-chain JSON -> strikes (strike prices above 500000 are quoted in paise). */
export function parseGrowwChain(json: any): { expiry: string | null; strikes: ChainStrike[] } {
  const rows: any[] = json?.optionChain?.optionChains || [];
  const side = (o: any) =>
    o ? { ltp: Number(o.ltp) || 0, oi: Number(o.openInterest) || 0, prevOi: Number(o.prevOpenInterest) || 0, volume: Number(o.volume) || 0 } : undefined;
  return {
    expiry: json?.optionChain?.expiryDetailsDto?.currentExpiry ?? null,
    strikes: rows.map((r) => {
      const raw = Number(r?.strikePrice);
      return { strike: raw >= 500000 ? Math.round(raw / 100) : Math.round(raw), call: side(r?.callOption), put: side(r?.putOption) };
    }),
  };
}
