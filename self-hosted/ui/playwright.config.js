import process from 'node:process'
import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.E2E_BASE_URL || 'http://localhost:5173'
const slow = !!process.env.PLAYWRIGHT_SLOW
const testTimeout = slow ? 30_000 : 15_000
const expectTimeout = slow ? 5_000 : 3_000

export default defineConfig({
  testDir: './e2e',
  timeout: testTimeout,
  expect: { timeout: expectTimeout },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    actionTimeout: 0,
    baseURL,
    trace: 'on-first-retry',
    headless: !process.env.PLAYWRIGHT_HEADED,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  // Start Vite dev server when no external base URL
  ...(!process.env.E2E_BASE_URL && {
    webServer: {
      command: process.env.CI ? 'vite preview --port 5173' : 'vite dev --port 5173',
      port: 5173,
      reuseExistingServer: !process.env.CI,
    },
  }),
})
