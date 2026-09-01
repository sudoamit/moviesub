import { PortfolioRiskManager } from '../portfolio-risk-manager';
import { IOpenPosition } from '../types';
import { Direction, IPositionSizing } from '@quant/shared';

describe('PortfolioRiskManager', () => {
  it('should allow valid new position within total risk and capacity limits', () => {
    const openPositions: IOpenPosition[] = [
      {
        id: 'pos-1',
        symbol: 'RELIANCE',
        assetType: 'EQUITY',
        direction: Direction.BULLISH,
        entryPrice: 2800,
        stopLoss: 2750,
        units: 20,
        riskAmount: 1000,
        currentPrice: 2820,
        unrealizedPnL: 400,
        openTimestamp: new Date(),
      },
    ];

    const proposed: IPositionSizing = {
      accountBalance: 100000,
      riskPercentage: 1.0,
      riskAmount: 1000,
      entryPrice: 1500,
      stopLoss: 1470,
      riskPerUnit: 30,
      calculatedUnits: 33,
      lotSize: 1,
      roundedUnits: 33,
      totalPositionValue: 49500,
      maximumLoss: 990,
      isValid: true,
    };

    const status = PortfolioRiskManager.validateNewPosition(100000, openPositions, proposed, 'EQUITY');
    expect(status.isAllowed).toBe(true);
    expect(status.totalOpenPositions).toBe(1);
  });

  it('should reject new position when total open risk exceeds maximum limit', () => {
    const openPositions: IOpenPosition[] = [
      { id: '1', symbol: 'A', assetType: 'EQUITY', direction: Direction.BULLISH, entryPrice: 100, stopLoss: 90, units: 10, riskAmount: 3000, currentPrice: 100, unrealizedPnL: 0, openTimestamp: new Date() },
      { id: '2', symbol: 'B', assetType: 'EQUITY', direction: Direction.BULLISH, entryPrice: 100, stopLoss: 90, units: 10, riskAmount: 3000, currentPrice: 100, unrealizedPnL: 0, openTimestamp: new Date() },
    ]; // Current risk = 6% on $100k

    const proposed: IPositionSizing = {
      accountBalance: 100000,
      riskPercentage: 1.0,
      riskAmount: 1000,
      entryPrice: 100,
      stopLoss: 90,
      riskPerUnit: 10,
      calculatedUnits: 100,
      lotSize: 1,
      roundedUnits: 100,
      totalPositionValue: 10000,
      maximumLoss: 1000,
      isValid: true,
    };

    const status = PortfolioRiskManager.validateNewPosition(100000, openPositions, proposed, 'CRYPTO', { maxOpenRiskPercent: 6.0 });
    expect(status.isAllowed).toBe(false);
    expect(status.rejectionReason).toContain('breach portfolio max open risk limit');
  });
});
