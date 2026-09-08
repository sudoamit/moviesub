import { MacroEventsService } from './macro-events.service';
export declare class MacroEventsController {
    private readonly macroEventsService;
    constructor(macroEventsService: MacroEventsService);
    getCalendar(): Promise<{
        events: import("./macro-events.service").IMacroEvent[];
        highImpactCount: number;
    }>;
    getVIXRegime(): Promise<import("./macro-events.service").IVIXRegime>;
}
