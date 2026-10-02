/**
 * NIFTY intraday study: searches session-based setups traded through options (closed by 15:15 IST) with
 * chronological validation. Usage: npx ts-node --transpile-only scripts/nifty-study.ts [1h|15m]
 */
import * as fs from 'fs';
import * as path from 'path';
import { describeIntraday, enumerateIntradayGenomes, IntradayInstrument, intradayStats, prepareSeries, simulateIntraday } from '../src/nifty-intraday';

const DIR = path.resolve(__dirname, '../../../data/strategy-lab');
const tf = process.argv[2] === '15m' ? '15m' : '1h';
// --sl30: every strategy uses a fixed 30-point NIFTY stop (targets 1.5R/2R/3R = 45/60/90 points, 15:15 or Supertrend exit)
const sl30 = process.argv.includes('--sl30');
// --sl40-80: fixed 40 / 60 / 80-point stops and a 1.5 x ATR stop kept within 40-80 points
const sl4080 = process.argv.includes('--sl40-80');
const barMs = tf === '15m' ? 15 * 60_000 : 60 * 60_000;
const INST: IntradayInstrument = 'ITM_OPTION';
const LOT = 75;

// Inverse normal CDF (Acklam) for the multiple-testing threshold
function zq(p: number): number {
  if (!(p > 0.5 && p < 1)) throw new Error('zq expects an upper-tail probability');
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const q = Math.sqrt(-2 * Math.log(1 - p));
  // Upper tail (p > 0.5): z = -(lower-tail rational approximation at 1 - p)
  return -((((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1));
}

const bars = JSON.parse(fs.readFileSync(path.join(DIR, `NIFTY_${tf}.json`), 'utf8'));
const s = prepareSeries(bars, barMs);
const dates = s.sessions.map((x) => x.date);
const split = dates[Math.floor(dates.length * 0.6)];
const genomes = sl4080 ? enumerateIntradayGenomes(barMs, ['PTS40', 'PTS60', 'PTS80', 'ATR_40_80'], ['EOD', 'R1_5', 'R2', 'R3', 'ST_FLIP']) : sl30 ? enumerateIntradayGenomes(barMs, ['PTS30'], ['EOD', 'R1_5', 'R2', 'R3', 'ST_FLIP']) : enumerateIntradayGenomes(barMs);
console.log(`NIFTY ${tf}: ${dates.length} sessions ${dates[0]}..${dates[dates.length - 1]} | search ${dates[0]}..${split} | hold-out ${split}.. | ${genomes.length} strategies | priced as ${INST}`);

const survivors = genomes
  .map((g) => ({ g, is: intradayStats(simulateIntraday(g, s, '0000', split), INST) }))
  .filter((x) => x.is.trades >= 40 && x.is.mean > 0 && x.is.tStat >= 2);
const needT = survivors.length ? zq(1 - 0.05 / survivors.length) : Infinity;
const evaluated = survivors.map((x) => {
  const oosTr = simulateIntraday(x.g, s, split);
  const oos = intradayStats(oosTr, INST);
  const half = Math.floor(oosTr.length / 2);
  const h1 = oosTr.slice(0, half).reduce((a, t) => a + t.pnl[INST], 0), h2 = oosTr.slice(half).reduce((a, t) => a + t.pnl[INST], 0);
  const fut = intradayStats(oosTr, 'FUTURES');
  const passed = oos.trades >= 25 && oos.mean > 0 && oos.tStat >= needT && h1 > 0 && h2 > 0;
  return { ...x, oos, h1, h2, fut, passed };
}).sort((a, b) => b.oos.tStat - a.oos.tStat);

console.log(`screen survivors: ${survivors.length} | hold-out t needed: ${Number.isFinite(needT) ? needT.toFixed(2) : '-'} | PASSED: ${evaluated.filter((e) => e.passed).length}`);
for (const e of evaluated.slice(0, 12)) {
  console.log(`${e.passed ? 'PASS' : 'near'} ${describeIntraday(e.g)}`);
  console.log(`     search ${e.is.trades} tr ${e.is.mean.toFixed(1)} pts (t ${e.is.tStat.toFixed(2)}) | hold-out ${e.oos.trades} tr, win ${(e.oos.winRate * 100).toFixed(0)}%, ${e.oos.mean.toFixed(1)} pts/trade = Rs ${Math.round(e.oos.total * LOT).toLocaleString('en-IN')}/lot (t ${e.oos.tStat.toFixed(2)}, halves ${e.h1.toFixed(0)}/${e.h2.toFixed(0)}) | futures ${e.fut.mean.toFixed(1)} pts`);
}
fs.writeFileSync(path.join(DIR, `nifty-study-${tf}${sl4080 ? '-sl40-80' : sl30 ? '-sl30' : ''}.json`), JSON.stringify({ tf, split, genomes: genomes.length, survivors: survivors.length, needT, results: evaluated.slice(0, 50) }, null, 2));
