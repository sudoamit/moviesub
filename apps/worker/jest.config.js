module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.test\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@quant/shared$': '<rootDir>/../../../packages/shared/src',
    '^@quant/config$': '<rootDir>/../../../packages/config/src',
  },
};
