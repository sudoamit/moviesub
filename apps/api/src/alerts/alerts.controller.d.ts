import { AlertsService } from './alerts.service';
import { CreateAlertDto, TestAlertDto } from './dto/create-alert.dto';
export declare class AlertsController {
    private readonly alertsService;
    constructor(alertsService: AlertsService);
    createAlert(body: CreateAlertDto): Promise<{
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
    listAlerts(): Promise<{
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
    testAlert(body: TestAlertDto): Promise<{
        success: boolean;
        channel: string;
        target: string;
        signal: import("@quant/shared").ISignalSetup;
        message?: undefined;
    } | {
        success: boolean;
        channel: string;
        message: string;
        signal: import("@quant/shared").ISignalSetup;
        target?: undefined;
    }>;
}
