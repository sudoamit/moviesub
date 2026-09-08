import { PaperTradingService, IPaperOrderRequest } from './paper-trading.service';
export declare class PaperTradingController {
    private readonly paperTradingService;
    constructor(paperTradingService: PaperTradingService);
    getPortfolio(): Promise<import("./execution-provider.interface").IPaperPortfolio>;
    placeOrder(orderDto: IPaperOrderRequest): Promise<import("./execution-provider.interface").IPaperPosition>;
    closePosition(body: {
        positionId: string;
        reason?: string;
    }): Promise<import("./execution-provider.interface").IPaperTradeHistory>;
    resetPortfolio(body: {
        initialCapital?: number;
    }): Promise<import("./execution-provider.interface").IPaperPortfolio>;
}
