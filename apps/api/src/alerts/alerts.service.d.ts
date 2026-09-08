import { PrismaService } from '../common/prisma/prisma.service';
import { TelegramDispatcher } from './dispatcher/telegram.dispatcher';
import { WebhookDispatcher } from './dispatcher/webhook.dispatcher';
import { AlertRateLimiter } from './dispatcher/rate-limiter';
import { CreateAlertDto, TestAlertDto } from './dto/create-alert.dto';
import { ISignalSetup } from '@quant/shared';
import { SignalsService } from '../signals/signals.service';
export declare class AlertsService {
    private readonly prisma;
    private readonly telegramDispatcher;
    private readonly webhookDispatcher;
    private readonly rateLimiter;
    private readonly signalsService;
    private readonly logger;
    constructor(prisma: PrismaService, telegramDispatcher: TelegramDispatcher, webhookDispatcher: WebhookDispatcher, rateLimiter: AlertRateLimiter, signalsService: SignalsService);
    createAlert(dto: CreateAlertDto, userId?: string): Promise<{
        minGrade: import(".prisma/client").$Enums.SignalGrade;
        minScore: number;
        channel: string;
        target: string;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        isActive: boolean;
        userId: string;
    }>;
    listAlerts(userId?: string): Promise<{
        minGrade: import(".prisma/client").$Enums.SignalGrade;
        minScore: number;
        channel: string;
        target: string;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        isActive: boolean;
        userId: string;
    }[]>;
    deleteAlert(id: string): Promise<{
        minGrade: import(".prisma/client").$Enums.SignalGrade;
        minScore: number;
        channel: string;
        target: string;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        isActive: boolean;
        userId: string;
    }>;
    processSignalAlert(signal: ISignalSetup): Promise<{
        processed: number;
        dispatched: number;
    }>;
    testAlert(dto: TestAlertDto): Promise<{
        success: boolean;
        channel: string;
        target: string;
        signal: ISignalSetup;
        message?: undefined;
    } | {
        success: boolean;
        channel: string;
        message: string;
        signal: ISignalSetup;
        target?: undefined;
    }>;
}
