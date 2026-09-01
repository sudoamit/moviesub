import { INDICATORS_VERSION } from '../index';

describe('Indicators Package', () => {
  it('should export version identifier', () => {
    expect(INDICATORS_VERSION).toBe('1.0.0');
  });
});
