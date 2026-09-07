import { ReturnAnalysisEngine } from '../return-analysis';

describe('ReturnAnalysisEngine', () => {
  it('should return zeros for empty or single element closes array', () => {
    const res = ReturnAnalysisEngine.calculate([]);
    expect(res.return1Bar).toBe(0);
    expect(res.return5Bar).toBe(0);
    expect(res.rollingMeanReturn).toBe(0);
  });

  it('should accurately calculate multi-bar returns', () => {
    // 6 closes: 100, 102, 104, 103, 105, 110
    const closes = [100, 102, 104, 103, 105, 110];
    const res = ReturnAnalysisEngine.calculate(closes);

    // return1Bar = (110 - 105) / 105 = 0.047619
    expect(res.return1Bar).toBeCloseTo(0.047619, 4);
    // return3Bar = (110 - 104) / 104 = 0.057692
    expect(res.return3Bar).toBeCloseTo(0.057692, 4);
    // return5Bar = (110 - 100) / 100 = 0.10
    expect(res.return5Bar).toBeCloseTo(0.1, 4);
    expect(res.rollingVariance).toBeGreaterThan(0);
  });

  it('should compute valid skewness and excess kurtosis', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 5 + i * 0.2);
    const res = ReturnAnalysisEngine.calculate(closes);

    expect(typeof res.returnSkewness).toBe('number');
    expect(typeof res.returnKurtosis).toBe('number');
    expect(isFinite(res.returnSkewness)).toBe(true);
    expect(isFinite(res.returnKurtosis)).toBe(true);
  });
});
