import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { Direction, SignalGrade, SignalState } from '@quant/shared';
import { LivePositionTracker } from '../components/LivePositionTracker';

/**
 * While an option position is open, the card shows the HELD contract and its own server-valued premium.
 * The latest signal's recommended strike can differ (screenshot: holding 22550 PE, recommendation 22500 PE),
 * and its premium (227) must never be shown as the position's LTP.
 */
describe('Held option contract display', () => {
  const now = Date.now();
  const bearishSignal: any = {
    id: 'sig_nifty_bear',
    symbol: 'NIFTY',
    timeframe: '15m',
    direction: Direction.BEARISH,
    state: SignalState.ACTIVE,
    grade: SignalGrade.A_PLUS,
    score: 95,
    canonicalCandleTime: now,
    entryZone: { min: 22515, max: 22525, optimal: 22520.75 },
    stopLoss: 22620,
    takeProfits: { tp1: 22320, tp2: 22220, tp3: 22020 },
    timestamp: new Date(now),
  };

  it('uses the held 22550 PE premium (260.00) and contract, not the recommendation', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(LivePositionTracker as any, {
        symbol: 'NIFTY',
        signal: bearishSignal,
        livePrice: 22312.5,
        activePosition: {
          id: 'pos_held_pe',
          symbol: 'NIFTY',
          contractSymbol: 'NIFTY 22550 PE',
          direction: 'BUY',
          quantity: 65,
          entryPrice: 263.01,
          currentPrice: 260.0,
          unrealizedPnL: -230.05,
          status: 'OPEN',
          openedAt: new Date(now).toISOString(),
        },
      }),
    );

    expect(html).toContain('NIFTY 22550 PE');
    expect(html).toContain('260.00');
    expect(html).toContain('-3.01');
    expect(html).not.toContain('-36.01');
    expect(html).not.toContain('22550 CE');
  });
});
