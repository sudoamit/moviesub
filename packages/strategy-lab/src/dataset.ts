import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Bar } from './types';

/**
 * RESEARCH DATASETS: TRAIN / VALIDATION / GOLDEN HOLDOUT.
 *
 *   |---------------- DEVELOPMENT ----------------|------ GOLDEN HOLDOUT ------|  (later bars: not in this version)
 *   |------- TRAIN -------|------ VALIDATION -----|
 *
 * - TRAIN: genome screening and model fitting.
 * - VALIDATION: strategy / model selection (the search's "hold-out" stage).
 * - GOLDEN HOLDOUT: never used for discovery, tuning, model fitting, threshold selection or ranking. It can only
 *   be read with a GoldenClearance, issued for one candidate that already passed every development gate, and
 *   every golden evaluation is logged so repeated looks at the same window are visible and budgeted.
 *
 * A dataset version is frozen when created: its golden window is fixed in time and the checksum of every bar up
 * to the golden end is stored. If the stored data later changes, the dataset refuses to load (fail closed); a
 * new version must be created explicitly. Bars after the version's golden end are not used by either side.
 */

export const DATASET_POLICY = {
  /** Share of the history (at version creation) reserved as the golden holdout */
  goldenFraction: 0.2,
  /** Share of the development period used for validation (the rest is training) */
  validationFraction: 0.4,
  /** Golden evaluations allowed per dataset version before a new version is required */
  goldenEvaluationBudget: 50,
};

export interface DatasetManifest {
  datasetVersion: string;
  symbol: string;
  /** Resolution of the stored bars */
  baseTimeframe: string;
  createdAt: string;
  firstBarTime: number;
  /** Development = [firstBarTime, goldenStart); validation starts at validationStart */
  validationStart: number;
  goldenStart: number;
  /** Last bar time included in this version */
  goldenEnd: number;
  developmentBars: number;
  validationBars: number;
  goldenBars: number;
  /** sha256 of every bar up to goldenEnd */
  checksum: string;
  policy: typeof DATASET_POLICY;
}

export interface GoldenEvaluationRecord {
  datasetVersion: string;
  candidateId: string;
  evaluatedAt: string;
  trades: number;
  passed: boolean;
}

export interface GoldenClearance {
  readonly datasetVersion: string;
  readonly candidateId: string;
  readonly gatesPassed: readonly string[];
  readonly __golden: true;
}

export function barsChecksum(bars: Bar[]): string {
  const h = createHash('sha256');
  for (const b of bars) h.update(`${b.t},${b.o},${b.h},${b.l},${b.c},${b.v};`);
  return h.digest('hex');
}

/** Creates (freezes) a new dataset version from the history as it is now. */
export function createManifest(symbol: string, bars: Bar[], baseTimeframe: string, now = new Date()): DatasetManifest {
  if (bars.length < 100) throw new Error(`createManifest: not enough bars for ${symbol} (${bars.length})`);
  const g0 = Math.floor(bars.length * (1 - DATASET_POLICY.goldenFraction));
  const v0 = Math.floor(g0 * (1 - DATASET_POLICY.validationFraction));
  const datasetVersion = `${symbol}@${now.toISOString().slice(0, 10)}#${barsChecksum(bars).slice(0, 8)}`;
  return {
    datasetVersion,
    symbol,
    baseTimeframe,
    createdAt: now.toISOString(),
    firstBarTime: bars[0].t,
    validationStart: bars[v0].t,
    goldenStart: bars[g0].t,
    goldenEnd: bars[bars.length - 1].t,
    developmentBars: g0,
    validationBars: g0 - v0,
    goldenBars: bars.length - g0,
    checksum: barsChecksum(bars),
    policy: { ...DATASET_POLICY },
  };
}

export class ResearchDataset {
  private constructor(
    readonly manifest: DatasetManifest,
    private readonly development: Bar[],
    private readonly golden: Bar[],
    private readonly log: GoldenEvaluationRecord[],
    private readonly onEvaluation: (r: GoldenEvaluationRecord) => void,
  ) {}

  /** Opens a frozen dataset version; throws DATASET_CHANGED if the stored history no longer matches it. */
  static open(
    manifest: DatasetManifest,
    history: Bar[],
    log: GoldenEvaluationRecord[] = [],
    onEvaluation: (r: GoldenEvaluationRecord) => void = () => undefined,
  ): ResearchDataset {
    const versioned = history.filter((b) => b.t >= manifest.firstBarTime && b.t <= manifest.goldenEnd);
    if (barsChecksum(versioned) !== manifest.checksum) {
      throw new Error(`DATASET_CHANGED: history of ${manifest.symbol} no longer matches dataset ${manifest.datasetVersion}; create a new version explicitly`);
    }
    const development = versioned.filter((b) => b.t < manifest.goldenStart);
    const golden = versioned.filter((b) => b.t >= manifest.goldenStart);
    return new ResearchDataset(manifest, development, golden, [...log], onEvaluation);
  }

  /** TRAIN + VALIDATION bars: the only bars discovery, tuning and model fitting may use. */
  developmentBars(): Bar[] {
    return this.development.slice();
  }

  /** Index in developmentBars() where VALIDATION starts. */
  validationStartIndex(): number {
    return this.development.findIndex((b) => b.t >= this.manifest.validationStart);
  }

  goldenEvaluationsUsed(): number {
    return this.log.filter((r) => r.datasetVersion === this.manifest.datasetVersion).length;
  }

  /**
   * Issues a clearance to evaluate ONE candidate on the golden holdout. Only candidates that passed every
   * development gate get one, and only while the version's golden evaluation budget lasts.
   */
  clearForGolden(candidateId: string, gates: Record<string, boolean>): GoldenClearance {
    const failed = Object.entries(gates).filter(([, ok]) => !ok).map(([g]) => g);
    if (!Object.keys(gates).length || failed.length) throw new Error(`GOLDEN_ACCESS_DENIED: ${candidateId} has not passed development gates (${failed.join(', ') || 'none given'})`);
    if (this.goldenEvaluationsUsed() >= this.manifest.policy.goldenEvaluationBudget) {
      throw new Error(`GOLDEN_BUDGET_EXHAUSTED: ${this.manifest.datasetVersion} has used its ${this.manifest.policy.goldenEvaluationBudget} golden evaluations; create a new dataset version`);
    }
    return { datasetVersion: this.manifest.datasetVersion, candidateId, gatesPassed: Object.keys(gates), __golden: true };
  }

  /**
   * Golden bars for ONE cleared candidate, prefixed with development bars as indicator warm-up (callers must only
   * count trades whose signal is at or after goldenStart). The evaluation is logged.
   */
  goldenBarsWithWarmup(clearance: GoldenClearance, warmupBars: number): { bars: Bar[]; goldenStartIndex: number; record: (trades: number, passed: boolean) => void } {
    if (!clearance || clearance.__golden !== true || clearance.datasetVersion !== this.manifest.datasetVersion) {
      throw new Error('GOLDEN_ACCESS_DENIED: invalid clearance');
    }
    const warm = this.development.slice(Math.max(0, this.development.length - warmupBars));
    let recorded = false;
    return {
      bars: [...warm, ...this.golden],
      goldenStartIndex: warm.length,
      record: (trades, passed) => {
        if (recorded) return;
        recorded = true;
        const r = { datasetVersion: this.manifest.datasetVersion, candidateId: clearance.candidateId, evaluatedAt: new Date().toISOString(), trades, passed };
        this.log.push(r);
        this.onEvaluation(r);
      },
    };
  }
}

/** File store: one frozen manifest per symbol and an append-only golden evaluation log. */
export class DatasetStore {
  constructor(private readonly dir: string) {}

  private manifestFile(symbol: string) {
    return path.join(this.dir, 'datasets', `${symbol}.manifest.json`);
  }

  private logFile() {
    return path.join(this.dir, 'datasets', 'golden-evaluations.jsonl');
  }

  manifest(symbol: string): DatasetManifest | null {
    const f = this.manifestFile(symbol);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  }

  /** Freezes a new version (explicit: only when none exists or when the caller decides to roll forward). */
  createVersion(symbol: string, history: Bar[], baseTimeframe: string): DatasetManifest {
    const m = createManifest(symbol, history, baseTimeframe);
    fs.mkdirSync(path.dirname(this.manifestFile(symbol)), { recursive: true });
    fs.writeFileSync(this.manifestFile(symbol), JSON.stringify(m, null, 2));
    return m;
  }

  goldenLog(): GoldenEvaluationRecord[] {
    const f = this.logFile();
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  }

  /** Opens the frozen dataset for a symbol, creating version 1 on first use. */
  open(symbol: string, history: Bar[], baseTimeframe: string): ResearchDataset {
    const m = this.manifest(symbol) ?? this.createVersion(symbol, history, baseTimeframe);
    return ResearchDataset.open(m, history, this.goldenLog(), (r) => {
      fs.mkdirSync(path.dirname(this.logFile()), { recursive: true });
      fs.appendFileSync(this.logFile(), JSON.stringify(r) + '\n');
    });
  }
}
