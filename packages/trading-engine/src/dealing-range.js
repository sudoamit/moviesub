"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DealingRangeEngine = void 0;
const shared_1 = require("@quant/shared");
class DealingRangeEngine {
    /**
     * Calculates dealing range, 50% equilibrium, premium, and discount zones from confirmed anchor swings
     */
    static calculateDealingRange(swings) {
        if (!swings || swings.length === 0) {
            return null;
        }
        const confirmedHighs = swings.filter((s) => s.type === shared_1.StructureType.SWING_HIGH ||
            s.type === shared_1.StructureType.HIGHER_HIGH ||
            s.type === shared_1.StructureType.LOWER_HIGH);
        const confirmedLows = swings.filter((s) => s.type === shared_1.StructureType.SWING_LOW ||
            s.type === shared_1.StructureType.HIGHER_LOW ||
            s.type === shared_1.StructureType.LOWER_LOW);
        if (confirmedHighs.length === 0 || confirmedLows.length === 0) {
            return null;
        }
        // Latest major swing high and swing low
        const anchorHigh = confirmedHighs[confirmedHighs.length - 1].price;
        const anchorLow = confirmedLows[confirmedLows.length - 1].price;
        const high = Math.max(anchorHigh, anchorLow);
        const low = Math.min(anchorHigh, anchorLow);
        if (high === low) {
            return null;
        }
        const equilibrium = (high + low) / 2;
        return {
            high,
            low,
            equilibrium,
            premiumZone: { min: equilibrium, max: high },
            discountZone: { min: low, max: equilibrium },
        };
    }
    /**
     * Classifies where a given price sits in the dealing range
     */
    static classifyPriceZone(price, range) {
        if (!range)
            return 'EQUILIBRIUM';
        if (price > range.equilibrium) {
            return 'PREMIUM';
        }
        if (price < range.equilibrium) {
            return 'DISCOUNT';
        }
        return 'EQUILIBRIUM';
    }
}
exports.DealingRangeEngine = DealingRangeEngine;
//# sourceMappingURL=dealing-range.js.map