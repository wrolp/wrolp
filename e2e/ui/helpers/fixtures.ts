import { test as base, expect } from '@playwright/test'
import { addCoverageReport } from 'monocart-reporter'

// All specs import `test`/`expect` from here instead of `@playwright/test` so
// every test automatically feeds V8 coverage into the monocart reporter.
// Collection only runs when `E2E_COVERAGE` is set (`yarn test:e2e:coverage`),
// so the normal `yarn test:e2e` run keeps its previous cost.
const COVERAGE_ENABLED = !!process.env.E2E_COVERAGE

export const test = base.extend({
  autoCoverage: [
    async ({ page }, use) => {
      if (COVERAGE_ENABLED) {
        await Promise.all([
          page.coverage.startJSCoverage({ resetOnNavigation: false }),
          page.coverage.startCSSCoverage({ resetOnNavigation: false }),
        ])
      }
      await use('autoCoverage')
      if (COVERAGE_ENABLED) {
        const [js, css] = await Promise.all([
          page.coverage.stopJSCoverage(),
          page.coverage.stopCSSCoverage(),
        ])
        await addCoverageReport([...js, ...css], test.info())
      }
    },
    { scope: 'test', auto: true },
  ],
})

export { expect }
export type { Page } from '@playwright/test'
