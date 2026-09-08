import { ScannerService } from './scanner.service';
import { Timeframe } from '@quant/shared';
export declare class ScannerController {
    private readonly scannerService;
    constructor(scannerService: ScannerService);
    triggerScan(timeframe?: Timeframe): Promise<{
        timestamp: string;
        timeframe: Timeframe;
        scannedCount: number;
        signalsFound: number;
        durationMs: number;
        signals: import("@quant/shared").ISignalSetup[];
    }>;
    getStatus(): Promise<any>;
}
