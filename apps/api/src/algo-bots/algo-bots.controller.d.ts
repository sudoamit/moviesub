import { AlgoBotsService, IAlgoBot } from './algo-bots.service';
export declare class AlgoBotsController {
    private readonly algoBotsService;
    constructor(algoBotsService: AlgoBotsService);
    listBots(): Promise<IAlgoBot[]>;
    createBot(body: Partial<IAlgoBot>): Promise<IAlgoBot>;
    toggleBot(id: string): Promise<IAlgoBot>;
    deleteBot(id: string): Promise<{
        success: boolean;
    }>;
}
