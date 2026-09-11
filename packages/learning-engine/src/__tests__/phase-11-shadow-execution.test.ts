import {
  ShadowExecutionSimulator,
  ShadowOrder
} from '../shadow-execution/index';

describe('Phase 11 — Shadow Execution Simulator & Isolated Portfolio', () => {
  let simulator: ShadowExecutionSimulator;

  beforeEach(() => {
    simulator = new ShadowExecutionSimulator({
      initialCapital: 100000,
      feeRateBps: 5, // 0.05%
      slippageBps: 2 // 0.02%
    });
  });

  it('simulates realistic fill with fees and slippage, opening an isolated shadow position', () => {
    const order: ShadowOrder = {
      shadowOrderId: 'sorder-01',
      decisionId: 'dec-chall-01',
      instrument: { symbol: 'BTCUSDT', market: 'BINANCE_SPOT' },
      side: 'BUY',
      quantity: 1.0,
      requestedPrice: 100000,
      stopLoss: 98000,
      takeProfit: 104000,
      orderType: 'MARKET',
      createdAt: 1700000000000,
      executionConfigVersion: 'exec-v1',
      costConfigVersion: 'cost-v1',
      status: 'PENDING'
    };

    const fill = simulator.submitShadowOrder(order);

    expect(fill.shadowOrderId).toBe('sorder-01');
    // Buy slippage = +2 bps of 100000 = +20 -> fillPrice = 100020
    expect(fill.fillPrice).toBe(100020);
    expect(fill.filledQuantity).toBe(1.0);
    // Fee = 100020 * 0.0005 = 50.01
    expect(fill.fee).toBeCloseTo(50.01, 2);
    expect(fill.slippage).toBe(20);

    const portfolio = simulator.getShadowPortfolioState();
    expect(portfolio.openPositions.length).toBe(1);
    expect(portfolio.openPositions[0].entryPrice).toBe(100020);
    expect(portfolio.openPositions[0].status).toBe('OPEN');
    expect(portfolio.shadowCash).toBeCloseTo(100000 - 50.01, 2);
  });

  it('closes a shadow position, updating shadow realized PnL, equity, and drawdown', () => {
    const order: ShadowOrder = {
      shadowOrderId: 'sorder-02',
      decisionId: 'dec-chall-02',
      instrument: { symbol: 'BTCUSDT', market: 'BINANCE_SPOT' },
      side: 'BUY',
      quantity: 1.0,
      requestedPrice: 100000,
      stopLoss: 98000,
      takeProfit: 104000,
      orderType: 'MARKET',
      createdAt: 1700000000000,
      executionConfigVersion: 'exec-v1',
      costConfigVersion: 'cost-v1',
      status: 'PENDING'
    };

    simulator.submitShadowOrder(order);
    const openPos = simulator.getShadowPortfolioState().openPositions[0];

    // Close position at 104000 (Take Profit)
    const closedPos = simulator.closeShadowPosition(
      openPos.positionId,
      104000,
      1700003600000,
      'TARGET_HIT'
    );

    expect(closedPos.status).toBe('TARGET_HIT');
    expect(closedPos.exitPrice).toBe(104000);
    expect(closedPos.realizedPnL).toBeGreaterThan(3800); // 104000 - 100020 - fees

    const portfolio = simulator.getShadowPortfolioState();
    expect(portfolio.openPositions.length).toBe(0);
    expect(portfolio.shadowEquity).toBeGreaterThan(100000);
    expect(portfolio.shadowDrawdownPercent).toBe(0);
  });
});
