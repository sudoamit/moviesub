module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.test\\.ts$',
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  moduleNameMapper: {
    '^@quant/backtesting$': '<rootDir>/../../backtesting/src',
    '^@quant/backtesting/(.*)$': '<rootDir>/../../backtesting/src/$1',
    '^@quant/risk-engine$': '<rootDir>/../../risk-engine/src',
    '^@quant/risk-engine/(.*)$': '<rootDir>/../../risk-engine/src/$1',
    '^@quant/trading-engine$': '<rootDir>/../../trading-engine/src',
    '^@quant/trading-engine/(.*)$': '<rootDir>/../../trading-engine/src/$1',
    '^@quant/indicators$': '<rootDir>/../../indicators/src',
    '^@quant/indicators/(.*)$': '<rootDir>/../../indicators/src/$1',
    '^@quant/config$': '<rootDir>/../../config/src',
    '^@quant/config/(.*)$': '<rootDir>/../../config/src/$1',
    '^@quant/shared$': '<rootDir>/../../shared/src',
    '^@quant/shared/(.*)$': '<rootDir>/../../shared/src/$1',
  },
  testEnvironment: 'node',
};
