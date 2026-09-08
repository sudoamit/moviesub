import { OptionsService } from './options.service';
export declare class OptionsController {
    private readonly optionsService;
    constructor(optionsService: OptionsService);
    getOptionChain(symbol?: string, expiryDate?: string, spotPrice?: string): Promise<import("./options.service").IOptionChainResponse>;
    getSmartStrike(symbol?: string, direction?: 'BULLISH' | 'BEARISH', spotTarget?: string, spotStopLoss?: string, expiryDate?: string, spotPrice?: string, strike?: string): Promise<import("./options.service").ISmartOptionRecommendation>;
}
