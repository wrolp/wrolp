import { test, expect } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// Settings layout guards, one test per pane.
//
// The settings cards use `.settings-field`, which is a *column* (label above control).
// Checkbox rows opt out with `.checkbox-field` — and when that rule is missing or does
// not switch to a row, the box silently ends up on a line of its own, centred above its
// label (reported twice: the terminal toggles, then auto-record / the Docker log card).
// These assertions are geometry, not styling, so any future regression fails here.

async function openSettings(page: import('@playwright/test').Page) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.setViewportSize({ width: 1100, height: 760 })
  await installTauriMock(page, {})
  await page.goto('/')
  await page.locator('.titlebar-btn.settings-btn').click()
  await expect(page.locator('.settings-content')).toBeVisible()
  await page.waitForTimeout(300)
}

/**
 * Show one settings pane. General used to be a single scroll holding every card; it is
 * now one pane per sidebar entry, and a card only exists in the DOM while its own pane
 * is showing — so a spec has to name the pane it is looking in.
 */
async function openPane(page: import('@playwright/test').Page, name: string) {
  await page.locator('.settings-nav-item', { hasText: name }).click()
  await page.waitForTimeout(150)
}

/** Box + label geometry of one checkbox row. */
async function rowGeom(row: import('@playwright/test').Locator) {
  await row.scrollIntoViewIfNeeded()
  return row.evaluate((el) => {
    const box = el.querySelector('input[type="checkbox"]') as HTMLElement
    const label = el.querySelector('.settings-label') as HTMLElement
    const help = el.querySelector('.settings-help') as HTMLElement | null
    const rb = box.getBoundingClientRect()
    const rl = label.getBoundingClientRect()
    return {
      flexDirection: getComputedStyle(el).flexDirection,
      boxLeft: Math.round(rb.left),
      labelLeft: Math.round(rl.left),
      boxCenterY: Math.round(rb.top + rb.height / 2),
      labelCenterY: Math.round(rl.top + rl.height / 2),
      helpTop: help ? Math.round(help.getBoundingClientRect().top) : null,
      labelBottom: Math.round(rl.bottom),
    }
  })
}

test('checkbox rows put the box before the label, on the same line', async ({ page }) => {
  await openSettings(page)

  // Auto-record is in the Terminal pane; the Docker log wrap / follow toggles in
  // Docker's own. One locator across both would pass by accident, so each pane is
  // counted on its own.
  const panes: [string, number][] = [
    ['Terminal', 1],
    ['Docker', 2],
  ]
  for (const [pane, count] of panes) {
    await openPane(page, pane)
    const rows = page.locator('.settings-field.checkbox-field')
    await expect(rows, pane).toHaveCount(count)
    for (let i = 0; i < count; i++) {
      const g = await rowGeom(rows.nth(i))
      expect(g.flexDirection, `${pane} row ${i}`).toBe('row')
      expect(g.boxLeft, `${pane} row ${i}: box must precede the label`).toBeLessThan(g.labelLeft)
      expect(
        Math.abs(g.boxCenterY - g.labelCenterY),
        `${pane} row ${i}: box centred on the label`,
      ).toBeLessThanOrEqual(2)
    }
  }

  // The auto-record row carries a hint: it must wrap below the row, not sit beside the box.
  await openPane(page, 'Terminal')
  const autoRecord = await rowGeom(page.locator('.settings-field.checkbox-field').nth(0))
  expect(autoRecord.helpTop).not.toBeNull()
  expect(autoRecord.helpTop!).toBeGreaterThanOrEqual(autoRecord.labelBottom)
})

test('the appearance-history buttons are styled, not native', async ({ page }) => {
  // Those two buttons used to carry the `settings-help` *text* class (or no class), so the
  // browser's default button chrome showed through. Seed one snapshot so the rows render.
  await page.addInitScript(() => {
    try {
      localStorage.setItem(
        'wrolp-appearance-history',
        JSON.stringify([
          {
            undoId: 'u1',
            ts: Date.now(),
            source: 'ai',
            changes: { 'terminal.fontSize': 16 },
            previous: { 'terminal.fontSize': 14 },
          },
        ]),
      )
    } catch {
      /* ignore */
    }
  })
  await openSettings(page)
  // The history rows belong to the AI appearance card, which now sits in the AI pane.
  await openPane(page, 'AI Assistant')

  const geom = (loc: import('@playwright/test').Locator) =>
    loc.evaluate((el) => {
      const s = getComputedStyle(el)
      return {
        classes: Array.from(el.classList),
        border: `${s.borderTopWidth} ${s.borderTopStyle}`,
        background: s.backgroundColor,
        text: (el.textContent ?? '').trim(),
      }
    })

  // Scope to the history card (the only one with a `danger` button). The highlight card
  // has its own `settings-inline-btn` ("Add rule"), but it lives in another pane and is
  // therefore not in the DOM here — the scope is belt-and-braces, not load-bearing.
  const card = page.locator('.settings-card:has(.settings-inline-btn.danger)')
  const undo = card.locator('.settings-inline-btn:not(.danger)').first()
  await expect(undo).toBeVisible()
  const u = await geom(undo)
  expect(u.classes).toContain('settings-inline-btn')
  expect(u.border).toBe('1px solid')
  expect(u.background).not.toBe('rgba(0, 0, 0, 0)')

  const clear = card.locator('.settings-inline-btn.danger')
  await expect(clear).toBeVisible()
  const c = await geom(clear)
  expect(c.classes).toContain('danger')
  expect(c.border).toBe('1px solid')
  expect(c.background).not.toBe('rgba(0, 0, 0, 0)')
})

test('the custom-regex “add rule” button is styled, not native', async ({ page }) => {
  // It carried a hand-rolled copy of the small-button styles, `border: 1px solid
  // rgba(255,255,255,0.25)` included — a hardcoded white that disappears on the light
  // theme's card background. It now wears the same class as the history buttons.
  await openSettings(page)
  // Output highlighting is terminal behaviour, so the card moved to that pane.
  await openPane(page, 'Terminal')

  // The highlight card is the one holding the scheme select (`#terminal-hl-scheme`).
  const card = page.locator('.settings-card:has(#terminal-hl-scheme)')
  const add = card.locator('.settings-inline-btn')
  await expect(add).toHaveCount(1)
  await expect(add).toBeVisible()

  const g = await add.evaluate((el) => {
    const s = getComputedStyle(el)
    return {
      border: `${s.borderTopWidth} ${s.borderTopStyle}`,
      borderColor: s.borderTopColor,
      background: s.backgroundColor,
      inlineStyle: el.getAttribute('style') ?? '',
    }
  })
  expect(g.border).toBe('1px solid')
  expect(g.background).not.toBe('rgba(0, 0, 0, 0)')
  // No leftover inline styling — the class owns the look now (and no hardcoded white).
  expect(g.inlineStyle).toBe('')
  expect(g.borderColor).not.toContain('rgba(255, 255, 255')
})
