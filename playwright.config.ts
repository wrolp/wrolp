import { defineConfig } from '@playwright/test'

// Port the dev server runs on. Overridable so CI (a self-hosted runner often
// lives on a dev machine that already runs `yarn tauri dev` on 1420) can use a
// dedicated port instead of failing to bind.
const port = Number(process.env.E2E_PORT ?? 1420)

// Phase 1 E2E (see task/plans/e2e-testing.md 方案 A): run the Vite frontend
// (`yarn dev`) in a real browser with the Tauri backend stubbed by
// injecting a fake `window.__TAURI_INTERNALS__` (see e2e/ui/helpers/tauriMock.ts).
// No Rust build is required for these tests.
export default defineConfig({
  testDir: './e2e/ui',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'on-first-retry',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `yarn dev --port ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
