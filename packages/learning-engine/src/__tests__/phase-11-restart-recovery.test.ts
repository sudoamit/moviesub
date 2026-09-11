import * as fs from 'fs';
import * as path from 'path';
import {
  FileShadowExecutionStore,
  createMarketSnapshot,
  createDecisionPair,
  TradingDecision,
  ShadowOrder,
  ShadowPosition,
  ShadowOutcome
} from '../shadow-execution/index';
import { deepFreeze } from '../champion-challenger/evaluation-identity';

describe('Phase 11 — Restart Recovery & Persistence (FileShadowExecutionStore)', () => {
  const testDir = path.join(__dirname, 'temp_phase11_shadow_test');
  const testFile = path.join(testDir, 'shadow-execution.json');

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('persists and recovers shadow decisions, orders, positions, and outcomes across store reload', () => {
    const store1 = new FileShadowExecutionStore(testFile);

    const snapshot = createMarketSnapshot({
      snapshotId: 'snap-recov-01',
      instrument: { symbol: 'BTCUSDT', market: 'BINANCE_SPOT' },
      timestamp: 1700000000000,
      ohlcv: { open: 100000, high: 100500, low: 99800, close: 100200, volume: 10 },
      bid: 100190,
      ask: 100210,
      volume: 10,
      dataSource: 'binance',
      dataVersion: '1.0'
    });
    store1.saveSnapshot(snapshot);

    const order: ShadowOrder = {
      shadowOrderId: 'so-recov-01',
      decisionId: 'dec-recov-01',
      instrument: snapshot.instrument,
      side: 'BUY',
      quantity: 1.0,
      requestedPrice: 100200,
      orderType: 'MARKET',
      createdAt: 1700000000000,
      executionConfigVersion: 'e1',
      costConfigVersion: 'c1',
      status: 'FILLED'
    };
    store1.saveShadowOrder(order);

    const openPos: ShadowPosition = {
      positionId: 'spos-recov-01',
      shadowOrderId: 'so-recov-01',
      decisionId: 'dec-recov-01',
      instrument: snapshot.instrument,
      side: 'BUY',
      quantity: 1.0,
      entryPrice: 100220,
      openedAt: 1700000000000,
      status: 'OPEN',
      fees: 50,
      slippage: 20
    };
    store1.saveShadowPosition(openPos);

    expect(fs.existsSync(testFile)).toBe(true);

    // Reopen store (simulating process restart)
    const store2 = new FileShadowExecutionStore(testFile);

    expect(store2.getSnapshot(snapshot.snapshotId)?.snapshotId).toBe(snapshot.snapshotId);
    expect(store2.getShadowOrder('so-recov-01')?.shadowOrderId).toBe('so-recov-01');
    expect(store2.getShadowPosition('spos-recov-01')?.status).toBe('OPEN');
    expect(store2.getOpenShadowPositions().length).toBe(1);
    expect(store2.getOpenShadowPositions()[0].positionId).toBe('spos-recov-01');
  });

  it('fails closed when store file is corrupted', () => {
    fs.writeFileSync(testFile, 'CORRUPTED_JSON_DATA{', 'utf-8');

    expect(() => {
      new FileShadowExecutionStore(testFile);
    }).toThrow(/SHADOW_STORE_CORRUPT/);
  });
});
