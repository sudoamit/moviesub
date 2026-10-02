import { QUALITY_FEATURES } from '@quant/strategy-lab';
import { LabQualityService } from '../lab-quality.service';

describe('LabQualityService.assess', () => {
  const d = QUALITY_FEATURES.length;
  // Model whose prediction = 0.4 + 0.5 x (first feature, standardized with mean 0 / sd 1)
  const modelJson = {
    featureNames: [...QUALITY_FEATURES], means: new Array(d).fill(0), sds: new Array(d).fill(1),
    weights: QUALITY_FEATURES.map((n, i) => (n === 'bias' ? 0.4 : i === 0 ? 0.5 : 0)), lambda: 10, trainedOn: 300,
  };
  const x = (first: number) => QUALITY_FEATURES.map((n, i) => (n === 'bias' ? 1 : i === 0 ? first : 0));
  const service = (row: any) => new LabQualityService({ labQualityModel: { findFirst: jest.fn().mockResolvedValue(row) } } as any);

  it('is neutral without a model', async () => {
    expect(await service(null).assess('s', x(1), 0.4)).toMatchObject({ active: false, skip: false, sizeMultiplier: 1, predictedR: null });
  });

  it('records the prediction but stays neutral when the model is INACTIVE', async () => {
    const a = await service({ id: 'm1', status: 'INACTIVE', modelJson, validationJson: { skipRuleValidated: true } }).assess('s', x(-3), 0.4);
    expect(a.predictedR).toBeCloseTo(-1.1, 6);
    expect(a).toMatchObject({ active: false, skip: false, sizeMultiplier: 1 });
  });

  it('sizes by the prediction when ACTIVE, and skips only with a validated skip rule', async () => {
    const active = (skipRuleValidated: boolean) => service({ id: 'm2', status: 'ACTIVE', modelJson, validationJson: { skipRuleValidated } });
    expect((await active(false).assess('s', x(1), 0.4)).sizeMultiplier).toBe(1.5);   // 0.9R vs 0.4R mean -> capped 1.5x
    expect((await active(false).assess('s', x(-0.5), 0.4)).sizeMultiplier).toBe(0.5); // 0.15R -> floored 0.5x
    expect((await active(false).assess('s', x(-3), 0.4)).skip).toBe(false);
    expect((await active(true).assess('s', x(-3), 0.4)).skip).toBe(true);
  });
});
