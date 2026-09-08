import { ISignalSetup } from '@quant/shared';
export declare class WebhookDispatcher {
    private readonly logger;
    dispatchWebhook(url: string, signal: ISignalSetup): Promise<{
        success: boolean;
        status?: number;
    }>;
}
