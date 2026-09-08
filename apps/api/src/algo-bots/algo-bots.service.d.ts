import { PaperTradingService } from '../paper-trading/paper-trading.service';
import { AlertsService } from '../alerts/alerts.service';
import { ISignalSetup } from '@quant/shared';
export interface IAlgoBot {
    id: string;
    name: string;
    symbol: string;
    direction: 'BULLISH' | 'BEARISH' | 'ANY';
    timeframe: string;
    minScore: number;
    smcCondition: 'ORDER_BLOCK' | 'FVG' | 'LIQUIDITY_SWEEP' | 'ANY_CONFLUENCE';
    lots: number;
    autoExecutePaper: boolean;
    notifyWebhook: boolean;
    isActive: boolean;
    createdAt: string;
    triggerCount: number;
    lastTriggeredAt?: string;
    lastTriggerDetails?: string;
}
export declare class AlgoBotsService {
    private readonly paperTradingService;
    private readonly alertsService;
    private readonly logger;
    private bots;
    constructor(paperTradingService: PaperTradingService, alertsService: AlertsService);
    listBots(): Promise<IAlgoBot[]>;
    createBot(dto: Partial<IAlgoBot>): Promise<IAlgoBot>;
    toggleBot(id: string): Promise<IAlgoBot>;
    deleteBot(id: string): Promise<{
        success: boolean;
    }>;
    /**
     * Evaluates incoming signal against all active bot strategies
     */
    evaluateSignalForBots(signal: ISignalSetup): Promise<void>;
}
