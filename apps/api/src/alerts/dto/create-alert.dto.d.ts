import { SignalGrade } from '@quant/shared';
export declare class CreateAlertDto {
    channel: string;
    target: string;
    minScore?: number;
    minGrade?: SignalGrade;
    isActive?: boolean;
}
export declare class TestAlertDto {
    channel: string;
    target: string;
    symbol?: string;
}
