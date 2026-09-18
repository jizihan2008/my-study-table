'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  // tests/probe/** 是临时诊断探针，只在显式指定路径时运行
  testIgnore: ['**/probe/**'],
  timeout: 30000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'line',
  use: { trace: 'retain-on-failure' }
});
