import { ISignalSetup } from '@quant/shared';
export declare class TelegramDispatcher {
    private readonly logger;
    private readonly botToken;
    dispatchAlert(chatId: string, signal: ISignalSetup): Promise<{
        success: boolean;
        messageId?: string;
    }>;
}
