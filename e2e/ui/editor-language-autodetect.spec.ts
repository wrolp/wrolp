/**
 * Language auto-detection for files whose NAME says nothing.
 *
 * `detectLanguage` only reads the filename, and `openInEditor` used to freeze
 * that answer before the content arrived — so an extension-less script stayed
 * Plain Text forever. The content load now refines a still-default language
 * (shebang / vim-Emacs modeline / first-line markup), while a name that already
 * names a language stays authoritative.
 */
import { test, expect, type Page } from './helpers/fixtures'
import { selectRailMode } from './helpers/sections'
import { installTauriMock } from './helpers/tauriMock'

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

const entry = (name: string, path: string, content: string) => ({
  name,
  path,
  isDir: false,
  size: content.length,
  mode: '-rw-r--r--',
  modified: '',
})

/** The editor toolbar's first select is the language picker. */
const languageSelect = (page: Page) => page.locator('.editor-select select').first()

async function openFile(page: Page, name: string, content: string) {
  const path = `/home/root/${name}`
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    fileEntries: [entry(name, path, content)],
    fileContent: {
      path,
      content,
      size: content.length,
      mode: '-rw-r--r--',
      isBinary: false,
      isTooLarge: false,
      encoding: 'utf-8',
      needsEncoding: false,
    },
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await selectRailMode(page, 'files')
  await page.locator('.tree-row.file', { hasText: name }).click()
  await expect(page.locator('.monaco-editor')).toBeVisible()
}

test('an extension-less script is detected from its shebang', async ({ page }) => {
  await openFile(page, 'deploy', '#!/usr/bin/env -S python3 -u\nprint("hi")\n')
  await expect(languageSelect(page)).toHaveValue('python')
})

test('a vim modeline counts when there is no shebang', async ({ page }) => {
  await openFile(page, 'settings', '# vim: ft=yaml\nmode: prod\nreplicas: 2\n')
  await expect(languageSelect(page)).toHaveValue('yaml')
})

test('a known name beats the content', async ({ page }) => {
  await openFile(page, 'unit.service', '#!/bin/bash\necho not-a-script\n')
  await expect(languageSelect(page)).toHaveValue('ini')
})

test('an sshd_config is recognized by its name', async ({ page }) => {
  await openFile(page, 'sshd_config', 'Port 2222\nPermitRootLogin no\n')
  await expect(languageSelect(page)).toHaveValue('sshconfig')
})

test('no signal leaves the file as plain text', async ({ page }) => {
  await openFile(page, 'blob', 'just some words\nno language here\n')
  await expect(languageSelect(page)).toHaveValue('plaintext')
})
