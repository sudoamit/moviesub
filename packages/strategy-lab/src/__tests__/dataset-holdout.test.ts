import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createManifest, DatasetStore, ResearchDataset, DATASET_POLICY } from '../dataset';
import { assertDevelopmentOnly, evaluateGolden } from '../discovery';
import { mergeBars } from '../history';
import { searchStrategies } from '../search';
import { aggregateBars } from '../primitives';
import { INSTRUMENT_PROFILES } from '../profiles';
import { Bar, StrategyGenome } from '../types';

const M15 = 900_000;
function walk(n: number, seed: number, start = Date.UTC(2022, 0, 1)): Bar[] {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const out: Bar[] = [];
  let p = 40_000;
  for (let i = 0; i < n; i++) {
    const o = p, c = o * (1 + (rnd() - 0.495) * 0.006);
    out.push({ t: start + i * M15, o, h: Math.max(o, c) * (1 + rnd() * 0.002), l: Math.min(o, c) * (1 - rnd() * 0.002), c, v: 1 + rnd() });
    p = c;
  }
  return out;
}
const genome: StrategyGenome = { trigger: 'BREAKOUT_20', sides: 'BOTH', filters: [], stop: { type: 'ATR', atrMult: 2 }, rewardRisk: 2, maxBarsInTrade: 32, entryMode: 'MARKET', exit: 'FIXED' };

describe('golden holdout', () => {
  const history = walk(40_000, 9);
  const manifest = createManifest('BTCUSDT_PERP', history, '15m', new Date('2026-10-01T00:00:00Z'));
  const ds = ResearchDataset.open(manifest, history);

  it('partitions TRAIN | VALIDATION | GOLDEN by time, with the golden window at the end', () => {
    const dev = ds.developmentBars();
    expect(manifest.goldenBars).toBe(history.length - Math.floor(history.length * (1 - DATASET_POLICY.goldenFraction)));
    expect(dev.length).toBe(manifest.developmentBars);
    expect(dev[dev.length - 1].t).toBeLessThan(manifest.goldenStart);
    expect(dev[ds.validationStartIndex()].t).toBe(manifest.validationStart);
    expect(manifest.validationStart).toBeLessThan(manifest.goldenStart);
    expect(manifest.datasetVersion).toMatch(/^BTCUSDT_PERP@2026-10-01#/);
  });

  it('development data never contains golden bars, and the guard rejects bars that reach into golden', () => {
    expect(() => assertDevelopmentOnly(ds.developmentBars(), ds)).not.toThrow();
    expect(() => assertDevelopmentOnly(history, ds)).toThrow(/GOLDEN_CONTAMINATION/);
  });

  it('search results on development data cannot depend on the golden window (poisoned golden -> identical results)', () => {
    const poisoned = history.map((b) => (b.t >= manifest.goldenStart ? { ...b, o: b.o * 3, h: b.h * 3, l: b.l * 0.2, c: b.c * 0.5 } : b));
    const dsP = ResearchDataset.open(createManifest('BTCUSDT_PERP', poisoned, '15m', new Date('2026-10-01T00:00:00Z')), poisoned);
    const profile = { ...INSTRUMENT_PROFILES.BTCUSDT_PERP, barMs: 4 * M15 };
    const run = (d: ResearchDataset) => searchStrategies(aggregateBars(d.developmentBars(), 4, M15), profile, { genomes: [genome, { ...genome, exit: 'TRAIL', rewardRisk: 0 }] });
    expect(JSON.stringify(run(dsP))).toBe(JSON.stringify(run(ds)));
  });

  it('golden bars require a clearance issued only after every development gate passed', () => {
    expect(() => ds.clearForGolden('c1', {})).toThrow(/GOLDEN_ACCESS_DENIED/);
    expect(() => ds.clearForGolden('c1', { developmentSearch: true, validationHoldOut: false })).toThrow(/GOLDEN_ACCESS_DENIED.*validationHoldOut/);
    expect(() => ds.goldenBarsWithWarmup({ datasetVersion: manifest.datasetVersion, candidateId: 'x', gatesPassed: [], __golden: true } as any, 10)).not.toThrow();
    expect(() => ds.goldenBarsWithWarmup({ datasetVersion: 'other', candidateId: 'x', gatesPassed: [], __golden: true } as any, 10)).toThrow(/invalid clearance/);
    expect(() => ds.goldenBarsWithWarmup(undefined as any, 10)).toThrow(/invalid clearance/);
  });

  it('golden evaluations are logged and budgeted per dataset version', () => {
    const log: any[] = [];
    const d = ResearchDataset.open({ ...manifest, policy: { ...manifest.policy, goldenEvaluationBudget: 2 } }, history, [], (r) => log.push(r));
    for (const id of ['a', 'b']) {
      const ev = evaluateGolden(genome, d, d.clearForGolden(id, { developmentSearch: true, validationHoldOut: true }), 'BTCUSDT_PERP', '1h', 0.2);
      expect(ev.datasetVersion).toBe(manifest.datasetVersion);
      expect(new Date(ev.from).getTime()).toBe(manifest.goldenStart);
    }
    expect(log.map((r) => r.candidateId)).toEqual(['a', 'b']);
    expect(d.goldenEvaluationsUsed()).toBe(2);
    expect(() => d.clearForGolden('c', { developmentSearch: true, validationHoldOut: true })).toThrow(/GOLDEN_BUDGET_EXHAUSTED/);
  });

  it('a frozen version refuses changed data (fail closed); appended bars after the version do not change it', () => {
    const edited = history.map((b, i) => (i === 1234 ? { ...b, c: b.c + 1 } : b));
    expect(() => ResearchDataset.open(manifest, edited)).toThrow(/DATASET_CHANGED/);
    const extended = [...history, ...walk(500, 77, history[history.length - 1].t + M15)];
    const d2 = ResearchDataset.open(manifest, extended);
    expect(d2.developmentBars()).toEqual(ds.developmentBars());
    const g = d2.goldenBarsWithWarmup(d2.clearForGolden('z', { developmentSearch: true }), 0);
    expect(g.bars[g.bars.length - 1].t).toBe(manifest.goldenEnd); // later bars are not part of this version
  });

  it('stored history is write-once: re-sent or revised bars never change stored bars', () => {
    const a = walk(10, 1);
    const revised = a.map((b) => ({ ...b, c: b.c * 1.01 }));
    const more = walk(3, 2, a[a.length - 1].t + M15);
    const { merged, added } = mergeBars(a, [...revised, ...more]);
    expect(added).toBe(3);
    expect(merged.slice(0, 10)).toEqual(a);
  });

  it('the store freezes version 1 on first use and reuses it; the golden log persists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-'));
    try {
      const store = new DatasetStore(dir);
      const v1 = store.open('BTCUSDT_PERP', history, '15m');
      const again = store.open('BTCUSDT_PERP', [...history, ...walk(100, 5, history[history.length - 1].t + M15)], '15m');
      expect(again.manifest.datasetVersion).toBe(v1.manifest.datasetVersion);
      const g = v1.goldenBarsWithWarmup(v1.clearForGolden('k', { developmentSearch: true }), 0);
      g.record(12, true);
      expect(new DatasetStore(dir).goldenLog()).toEqual([expect.objectContaining({ candidateId: 'k', trades: 12, passed: true })]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
