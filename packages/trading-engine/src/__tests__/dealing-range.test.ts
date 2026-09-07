import { DealingRangeEngine } from '../dealing-range';
import { ISwingPoint, StructureType } from '@quant/shared';

describe('DealingRangeEngine', () => {
  it('should calculate 50% equilibrium and classify premium / discount zones', () => {
    const swings: ISwingPoint[] = [
      {
        index: 2,
        type: StructureType.SWING_HIGH,
        price: 200,
        timestamp: new Date(),
        confirmedAtIndex: 4,
        confirmedAtTimestamp: new Date(),
      },
      {
        index: 8,
        type: StructureType.SWING_LOW,
        price: 100,
        timestamp: new Date(),
        confirmedAtIndex: 10,
        confirmedAtTimestamp: new Date(),
      },
    ];

    const range = DealingRangeEngine.calculateDealingRange(swings);
    expect(range).not.toBeNull();
    expect(range!.high).toBe(200);
    expect(range!.low).toBe(100);
    expect(range!.equilibrium).toBe(150);

    expect(DealingRangeEngine.classifyPriceZone(170, range!)).toBe('PREMIUM');
    expect(DealingRangeEngine.classifyPriceZone(130, range!)).toBe('DISCOUNT');
    expect(DealingRangeEngine.classifyPriceZone(150, range!)).toBe('EQUILIBRIUM');
  });
});
