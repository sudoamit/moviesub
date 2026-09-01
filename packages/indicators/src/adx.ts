import { ICandle } from '@quant/shared';
import { IADXResult } from './types';
import { calculateTrueRange } from './atr';

/**
 * Calculates Average Directional Index (ADX) along with +DI and -DI
 */
export function calculateADX(candles: ICandle[], period = 14): IADXResult {
  const len = candles.length;
  const adx: (number | null)[] = new Array(len).fill(null);
  const plusDI: (number | null)[] = new Array(len).fill(null);
  const minusDI: (number | null)[] = new Array(len).fill(null);

  if (len < period * 2) {
    return { adx, plusDI, minusDI };
  }

  const tr = calculateTrueRange(candles);
  const plusDM: number[] = new Array(len).fill(0);
  const minusDM: number[] = new Array(len).fill(0);

  for (let i = 1; i < len; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;

    if (upMove > downMove && upMove > 0) {
      plusDM[i] = upMove;
    }
    if (downMove > upMove && downMove > 0) {
      minusDM[i] = downMove;
    }
  }

  // Initial smoothed TR, +DM, -DM
  let smoothTR = 0;
  let smoothPlusDM = 0;
  let smoothMinusDM = 0;

  for (let i = 1; i <= period; i++) {
    smoothTR += tr[i];
    smoothPlusDM += plusDM[i];
    smoothMinusDM += minusDM[i];
  }

  const dxList: number[] = [];

  const calcDIandDX = (str: number, spdm: number, smdm: number) => {
    const pDI = str === 0 ? 0 : (spdm / str) * 100;
    const mDI = str === 0 ? 0 : (smdm / str) * 100;
    const sum = pDI + mDI;
    const dx = sum === 0 ? 0 : (Math.abs(pDI - mDI) / sum) * 100;
    return { pDI, mDI, dx };
  };

  const firstDI = calcDIandDX(smoothTR, smoothPlusDM, smoothMinusDM);
  plusDI[period] = firstDI.pDI;
  minusDI[period] = firstDI.mDI;
  dxList.push(firstDI.dx);

  for (let i = period + 1; i < len; i++) {
    smoothTR = smoothTR - smoothTR / period + tr[i];
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];

    const di = calcDIandDX(smoothTR, smoothPlusDM, smoothMinusDM);
    plusDI[i] = di.pDI;
    minusDI[i] = di.mDI;
    dxList.push(di.dx);

    if (dxList.length === period) {
      // First ADX is simple average of first period DX values
      let sumDX = 0;
      for (let j = 0; j < period; j++) {
        sumDX += dxList[j];
      }
      adx[i] = sumDX / period;
    } else if (dxList.length > period) {
      const prevAdx = adx[i - 1]!;
      const currentDx = di.dx;
      adx[i] = (prevAdx * (period - 1) + currentDx) / period;
    }
  }

  return { adx, plusDI, minusDI };
}
