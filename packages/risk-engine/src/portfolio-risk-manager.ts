import { IOpenPosition, IRiskConfig } from './types';
import { IPositionSizing } from '@quant/shared';

export interface IPortfolioRiskStatus {
  totalOpenPositions: number;
  totalOpenRiskAmount: number;
  totalOpenRiskPercent: number;
  positionsByAssetType: Record<string, number>;
  isAllowed: boolean;
  rejectionReason?: string;
}

export class PortfolioRiskManager {
  /**
   * Validates portfolio-level risk capacity and sector exposure limits
   */
  static validateNewPosition(
    accountEquity: number,
    openPositions: IOpenPosition[],
    proposedPosition: IPositionSizing,
    proposedAssetType = 'EQUITY',
    config: IRiskConfig = {},
  ): IPortfolioRiskStatus {
    const maxOpenRiskPct = config.maxOpenRiskPercent ?? 6.0;
    const maxConcurrent = config.maxConcurrentPositions ?? 5;
    const maxPerAssetType = 3;

    let totalOpenRiskAmount = 0;
    const positionsByAssetType: Record<string, number> = {};

    for (const pos of openPositions) {
      totalOpenRiskAmount += pos.riskAmount;
      positionsByAssetType[pos.assetType] = (positionsByAssetType[pos.assetType] || 0) + 1;
    }

    const currentOpenRiskPercent = (totalOpenRiskAmount / Math.max(1, accountEquity)) * 100;
    const totalRiskWithProposed = currentOpenRiskPercent + proposedPosition.riskPercentage;

    let isAllowed = true;
    let rejectionReason: string | undefined = undefined;

    if (openPositions.length >= maxConcurrent) {
      isAllowed = false;
      rejectionReason = `Maximum concurrent portfolio positions limit reached (${openPositions.length}/${maxConcurrent})`;
    } else if (totalRiskWithProposed > maxOpenRiskPct) {
      isAllowed = false;
      rejectionReason = `Proposed position would breach portfolio max open risk limit (${totalRiskWithProposed.toFixed(2)}% > ${maxOpenRiskPct}%)`;
    } else if ((positionsByAssetType[proposedAssetType] || 0) >= maxPerAssetType) {
      isAllowed = false;
      rejectionReason = `Maximum exposure reached for asset class '${proposedAssetType}' (${positionsByAssetType[proposedAssetType]}/${maxPerAssetType})`;
    }

    return {
      totalOpenPositions: openPositions.length,
      totalOpenRiskAmount: Number(totalOpenRiskAmount.toFixed(2)),
      totalOpenRiskPercent: Number(currentOpenRiskPercent.toFixed(2)),
      positionsByAssetType,
      isAllowed,
      rejectionReason,
    };
  }
}
