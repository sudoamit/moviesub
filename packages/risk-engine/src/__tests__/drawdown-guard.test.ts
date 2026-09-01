import { DrawdownGuard } from '../drawdown-guard';

describe('DrawdownGuard', () => {
  it('should halt trading when maximum account drawdown (10%) is breached', () => {
    const peak = 100000;
    const current = 89000; // 11% drawdown
    const startDay = 95000;

    const status = DrawdownGuard.evaluateDrawdown(current, peak, startDay, {
      maxAccountDrawdownPercent: 10,
      maxDailyDrawdownPercent: 5,
    });

    expect(status.isTradingHalted).toBe(true);
    expect(status.totalDrawdownPercent).toBe(11);
    expect(status.warningMessage).toContain('Maximum account drawdown breached');
  });

  it('should reduce risk multiplier by 50% when approaching warning threshold', () => {
    const peak = 100000;
    const current = 92500; // 7.5% drawdown (approaching 10%)
    const startDay = 96000;

    const status = DrawdownGuard.evaluateDrawdown(current, peak, startDay, {
      maxAccountDrawdownPercent: 10,
      maxDailyDrawdownPercent: 5,
    });

    expect(status.isTradingHalted).toBe(false);
    expect(status.riskReductionMultiplier).toBe(0.5);
  });
});
