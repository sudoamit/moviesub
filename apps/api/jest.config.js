module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.(spec|test)\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  // Isolates DB-backed tests from the app database (see test/setup-test-db.js).
  setupFiles: ['<rootDir>/../test/setup-test-db.js'],
  moduleNameMapper: {
    '^@quant/shared$': '<rootDir>/../../../packages/shared/dist',
    '^@quant/config$': '<rootDir>/../../../packages/config/dist',
  },
};
