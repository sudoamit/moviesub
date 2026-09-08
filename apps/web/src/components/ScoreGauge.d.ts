import React from 'react';
import { IScoreBreakdown, SignalGrade } from '@quant/shared';
interface ScoreGaugeProps {
    score: number;
    grade: SignalGrade;
    breakdown?: IScoreBreakdown;
}
export declare const ScoreGauge: React.FC<ScoreGaugeProps>;
export {};
