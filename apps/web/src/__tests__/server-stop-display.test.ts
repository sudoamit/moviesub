import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { Direction, SignalGrade, SignalState } from '@quant/shared';
import { LivePositionTracker } from '../components/LivePositionTracker';

beforeAll(() => {
  const store: Record<string, string> = {};
  (global as any).localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => Object.keys(store).forEach((k) => delete store[k]),
    length: 0,
    key: () => null,
  };
  (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
});

/**
 * F-3: the tracker must show the stop the SERVER enforces. It previously displayed a client-only trailing stop
 * and a client-only "breakeven" that the server never applied.
 */
describe('Tracker shows the server-enforced stop', () => {
  const signal: any = {
    id: 'sig_btc_srv_stop',
    symbol: 'BTCUSDT_SPOT',
    timeframe: '15m',
    direction: Direction.BULLISH,
    state: SignalState.ACTIVE,
    grade: SignalGrade.A,
    score: 85,
    entryZone: { min: 59990, max: 60010, optimal: 60000 },
    stopLoss: 59700, // planned stop (differs from the position's actual stops)
    takeProfits: { tp1: 60750, tp2: 61250, tp3: 62000 },
    riskRewardRatios: { rr1: 1.5, rr2: 2.5, rr3: 4 },
    reasoning: { summary: 'x', confirmedChecklist: [] },
    scoreBreakdown: {},
  };

  it('renders the position stop moved to fee-adjusted breakeven by the server, and no trailing toggle', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(LivePositionTracker as any, {
        symbol: 'BTCUSDT_SPOT',
        signal,
        livePrice: 60900,
        activePosition: {
          id: 'pos_srv_stop',
          symbol: 'BTCUSDT_SPOT',
          direction: 'BUY',
          quantity: 0.01,
          entryPrice: 60054,
          initialStopLoss: 59500,
          stopLoss: 60174.5, // server: fee-adjusted breakeven after TP1
          target1: 60750,
          target2: 61250,
          target3: 62000,
          status: 'PARTIALLY_CLOSED',
          openedAt: new Date().toISOString(),
        },
      }),
    );

    expect(html).toContain('60174.50');
    expect(html).not.toContain('Enable Trailing SL');
    expect(html).not.toContain('Trailing SL Active');
    // Planned signal stop is not presented as the position's stop
    expect(html).not.toContain('59700.00');
  });
});
