import { defineConfig, type ReporterDescription } from '@playwright/test'

// Port the dev server runs on. Overridable so CI (a self-hosted runner often
// lives on a dev machine that already runs `yarn tauri dev` on 1420) can use a
// dedicated port instead of failing to bind.
const port = Number(process.env.E2E_PORT ?? 1420)

// Frontend code coverage is opt-in (`yarn test:e2e:coverage`, which sets
// E2E_COVERAGE): the specs' automatic fixture starts/stops V8 coverage per test
// and this reporter merges it into an HTML + json-summary report. A normal
// `yarn test:e2e` run stays on the plain list reporter.
const reporters: ReporterDescription[] = [['list']]
if (process.env.E2E_COVERAGE) {
  reporters.push([
    'monocart-reporter',
    {
      name: 'Wrolp Terminal E2E coverage',
      outputFile: 'coverage/e2e/index.html',
      coverage: {
        outputDir: 'coverage/e2e/data',
        reports: ['html', 'json-summary', 'text-summary', 'lcovonly'],
        // Only the app's own modules. Vite serves them from the dev server's
        // `/src/` path, while dependencies come from `/node_modules/.vite/deps`
        // (or `/@fs/…`) — filtering here, at the script-URL level, is what keeps
        // xterm/monaco/debug sources out of the totals. Filtering later (via
        // `sourceFilter`) is too late: source maps have already attributed
        // dependency files to their own `src/` paths by then.
        entryFilter: (entry: { url: string }) =>
          entry.url.includes(`localhost:${port}/src/`) && !entry.url.includes('/node_modules/'),
      },
    },
  ])
}

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
  reporter: reporters,
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
