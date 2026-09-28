import { test, expect } from '@playwright/test'
import { detectLsCommand, parseLsBlock } from '../../src/lib/lsParse'

// What `dir` / `ls` output actually parses into clickable entries.
//
// `parseDirLine` used to demand a US-ordered date (`09/28/2026`), so on a Chinese
// Windows (`2026-09-28`) it matched nothing and `dir` produced no clickable names at
// all. The link provider's own column handling (Terminal.tsx) is covered by the
// `entry.col` invariant asserted below: it is the raw line's column, which is what
// lets the provider match a name against the buffer text.

const CHINESE_DIR = [
  'dir',
  ' 驱动器 D 中的卷是  本地磁盘',
  '',
  ' D:\\wrolp\\wrolp-win  的目录',
  '',
  '2026-09-28  01:20    <DIR>          .',
  '2026-09-08  20:00    <DIR>          ..',
  '2026-09-16  10:23    <DIR>          .codebuddy',
  '2026-09-19  14:14               414 .gitignore',
  '2026-09-19  15:01             9,343 AGENTS.md',
  '2026-09-13  22:02    <DIR>          coverage',
  '2026-09-27  16:13            21,342 README.md',
  '              15 个文件        250,202 字节',
]

const US_DIR = [
  'dir',
  '09/28/2026  01:20 PM    <DIR>          .',
  '09/16/2026  10:23 AM    <DIR>          .github',
  '09/19/2026  02:17 PM             614 index.html',
]

const MULTI_LS = [
  'ls',
  'AGENTS.md   README.zh.md   coverage   docs',
  'LICENSE     dist           e2e        src',
]

const names = (lines: string[]) => {
  const fmt = detectLsCommand(lines[0])
  expect(fmt).not.toBeNull()
  return parseLsBlock(lines.join('\n'), fmt!)
}

test('a Chinese-locale dir yields its names, including dot files', () => {
  const entries = names(CHINESE_DIR)
  expect(entries.map((e) => e.name)).toEqual([
    '.codebuddy',
    '.gitignore',
    'AGENTS.md',
    'coverage',
    'README.md',
  ])
  expect(entries.find((e) => e.name === 'coverage')?.kind).toBe('dir')
  expect(entries.find((e) => e.name === 'README.md')?.kind).toBe('file')
})

test('the US layout still parses (the format the parser was written against)', () => {
  expect(names(US_DIR).map((e) => e.name)).toEqual(['.github', 'index.html'])
})

test('`dir` skips the . and .. rows every listing carries', () => {
  expect(names(CHINESE_DIR).some((e) => e.name === '.' || e.name === '..')).toBe(false)
})

test('entry.col is the column in the raw line, for every entry', () => {
  // The link provider locates a name in the terminal buffer by proximity to this
  // column, so a col measured against anything else silently drops the entry.
  for (const lines of [CHINESE_DIR, US_DIR, MULTI_LS]) {
    for (const e of names(lines)) {
      expect(lines[e.line].slice(e.col, e.col + e.name.length)).toBe(e.name)
    }
  }
})

test('a multi-column ls keeps every column, at its own column', () => {
  const entries = names(MULTI_LS)
  expect(entries.map((e) => e.name)).toEqual([
    'AGENTS.md',
    'README.zh.md',
    'coverage',
    'docs',
    'LICENSE',
    'dist',
    'e2e',
    'src',
  ])
})

test('a single-row piece is only echo-skippable when it is the first one', () => {
  // ConPTY flushes a local listing a row at a time, so a piece handed to the
  // colorizer is often exactly one entry line. Assuming line 0 is the echoed
  // command there dropped the only line the piece had — the real machine's
  // "no colour at all", while links kept working because the whole buffer is
  // parsed once at finalize.
  const row = '2026-09-16  10:23    <DIR>          backups'
  expect(parseLsBlock(row, 'dir', 200, false).map((e) => e.name)).toEqual(['backups'])
  expect(parseLsBlock(row, 'dir')).toEqual([])
})
