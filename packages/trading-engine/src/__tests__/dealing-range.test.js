"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const dealing_range_1 = require("../dealing-range");
const shared_1 = require("@quant/shared");
describe('DealingRangeEngine', () => {
    it('should calculate 50% equilibrium and classify premium / discount zones', () => {
        const swings = [
            {
                index: 2,
                type: shared_1.StructureType.SWING_HIGH,
                price: 200,
                timestamp: new Date(),
                confirmedAtIndex: 4,
                confirmedAtTimestamp: new Date(),
            },
            {
                index: 8,
                type: shared_1.StructureType.SWING_LOW,
                price: 100,
                timestamp: new Date(),
                confirmedAtIndex: 10,
                confirmedAtTimestamp: new Date(),
            },
        ];
        const range = dealing_range_1.DealingRangeEngine.calculateDealingRange(swings);
        expect(range).not.toBeNull();
        expect(range.high).toBe(200);
        expect(range.low).toBe(100);
        expect(range.equilibrium).toBe(150);
        expect(dealing_range_1.DealingRangeEngine.classifyPriceZone(170, range)).toBe('PREMIUM');
        expect(dealing_range_1.DealingRangeEngine.classifyPriceZone(130, range)).toBe('DISCOUNT');
        expect(dealing_range_1.DealingRangeEngine.classifyPriceZone(150, range)).toBe('EQUILIBRIUM');
    });
});
//# sourceMappingURL=dealing-range.test.js.map