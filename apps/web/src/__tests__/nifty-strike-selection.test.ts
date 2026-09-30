import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { Direction, SignalGrade, SignalState, ISignalSetup } from '@quant/shared';
import { LivePositionTracker } from '../components/LivePositionTracker';

beforeAll(() => {
  const store: Record<string, string> = {};
  (global as any).localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => Object.keys(store).forEach((k) => delete store[k]),
    length: 0,
    key: () => null,
  };
  (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
});

describe('NIFTY option strike follows the current signal', () => {
  it('with no signal, shows "no active signal" instead of a default BULLISH setup with a stale strike', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(LivePositionTracker as any, {
        symbol: 'NIFTY',
        signal: null,
        livePrice: 22729,
        activePosition: null,
        activeExecution: null,
      }),
    );
    expect(html).toContain('No active SMC signal for NIFTY');
    expect(html).not.toContain('24200 CE');
    expect(html).not.toContain('Strategy signal detected');
  });

  it('a BEARISH signal near 22,708 selects a nearby PE strike, not 24200 CE', () => {
    const signal: ISignalSetup = {
      id: 'smc_NIFTY_15m_BEARISH_SWEEP_1790749800000',
      symbol: 'NIFTY',
      timeframe: '15m' as any,
      direction: Direction.BEARISH,
      state: SignalState.ACTIVE,
      grade: SignalGrade.A_PLUS,
      score: 95,
      entryZone: { min: 22686.3, max: 22729.95, optimal: 22708.13 },
      stopLoss: 22808.13,
      takeProfits: { tp1: 22558.13, tp2: 22458.13, tp3: 22208.13 },
      riskRewardRatios: { rr1: 1.5, rr2: 2.5, rr3: 5 },
      reasoning: { summary: 'x', confirmedChecklist: [] } as any,
      scoreBreakdown: {} as any,
    } as any;

    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(LivePositionTracker as any, {
        symbol: 'NIFTY',
        signal,
        livePrice: 22729,
        activePosition: null,
        activeExecution: null,
      }),
    );
    expect(html).toContain('NIFTY 22700 PE');
    expect(html).not.toContain('24200');
  });
});
