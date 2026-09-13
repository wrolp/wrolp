// Runs the Playwright suite with frontend coverage collection enabled (see the
// `E2E_COVERAGE` branch in playwright.config.ts + e2e/ui/helpers/fixtures.ts),
// then prints the merged summary. Setting the env var here rather than in the
// npm script keeps `yarn test:e2e:coverage` working in cmd, PowerShell and Git
// Bash alike.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const res = spawnSync('npx', ['playwright', 'test'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, E2E_COVERAGE: '1' },
})

// monocart writes its raw data under coverage/e2e/data; the json-summary
// report is the machine-readable totals file.
const dataDir = path.resolve('coverage/e2e/data')
const summaryFile = fs.existsSync(dataDir)
  ? fs.readdirSync(dataDir).find((f) => f.endsWith('summary.json'))
  : undefined

if (summaryFile) {
  const total = JSON.parse(fs.readFileSync(path.join(dataDir, summaryFile), 'utf8')).total
  const pct = (k) => `${total[k].pct}% (${total[k].covered}/${total[k].total})`
  console.log('\n=== Frontend E2E coverage (src/) ===')
  console.log('lines     :', pct('lines'))
  console.log('statements:', pct('statements'))
  console.log('functions :', pct('functions'))
  console.log('branches  :', pct('branches'))
  console.log('html      : coverage/e2e/index.html')
} else {
  console.log('\n(no coverage summary found — did the tests run?)')
}

process.exit(res.status ?? 1)
