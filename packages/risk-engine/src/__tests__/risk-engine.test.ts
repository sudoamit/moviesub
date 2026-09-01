import { RISK_ENGINE_VERSION } from '../index';

describe('Risk Engine Package', () => {
  it('should export version identifier', () => {
    expect(RISK_ENGINE_VERSION).toBe('1.0.0');
  });
});
