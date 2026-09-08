import { IOpenPosition, IRiskConfig } from './types';
import { IPositionSizing } from '@quant/shared';
export interface IPortfolioMetricsInput {
    dailyRealizedPnL?: number;
    weeklyRealizedPnL?: number;
    currentDrawdownPercent?: number;
    consecutiveLosses?: number;
}
export interface IPortfolioRiskStatus {
    totalOpenPositions: number;
    totalOpenRiskAmount: number;
    totalOpenRiskPercent: number;
    totalGrossExposure: number;
    grossLeverage: number;
    positionsByAssetType: Record<string, number>;
    positionsBySymbol: Record<string, number>;
    isAllowed: boolean;
    rejectionReason?: string;
}
export declare class PortfolioRiskManager {
    /**
     * Validates comprehensive trade-level and portfolio-level risk capacity,
     * symbol concentration, sector exposure, max daily/weekly loss, drawdown, and leverage limits.
     * STRICT FAIL-CLOSED.
     */
    static validateNewPosition(accountEquity: number, openPositions: IOpenPosition[], proposedPosition: IPositionSizing, arg4?: string | IRiskConfig, arg5?: string | IRiskConfig, arg6?: IRiskConfig, metrics?: IPortfolioMetricsInput): IPortfolioRiskStatus;
}
