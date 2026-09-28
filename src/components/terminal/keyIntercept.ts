// Shared xterm keyboard interception.
//
// xterm exposes exactly ONE custom key handler per Terminal instance: a second
// `attachCustomKeyEventHandler` call silently replaces the first. Two features
// already need to swallow keys (this `cd` directory dropdown, and the ghost
// command-name completion in task/plans/SSH-COMMAND-INDEX-COMPLETION-PLAN.md),
// so consumers register a RULE here and only this module touches the slot.
//
// Rules are asked in registration order; the first one that consumes the event
// wins. Everything else falls through to xterm untouched, so a feature can never
// steal a key it does not own.

import type { Terminal } from '@xterm/xterm'

export interface KeyInterceptRule {
  /** Stable id — registering the same id twice replaces the earlier rule. */
  id: string
  /**
   * Handle one key DOWN event. Return true when the key was consumed: the event
   * is then cancelled so xterm neither types it nor lets the browser act on it
   * (Tab moving focus being the obvious one).
   */
  handle: (ev: KeyboardEvent) => boolean
}

export class KeyInterceptRouter {
  private rules: KeyInterceptRule[] = []
  private term: Terminal | null = null

  /** Take ownership of `term`'s single key-handler slot. Idempotent. */
  attach(term: Terminal): void {
    if (this.term === term) return
    this.term = term
    term.attachCustomKeyEventHandler(this.onEvent)
  }

  /** Give the slot back to xterm (nothing is intercepted afterwards). */
  detach(): void {
    if (!this.term) return
    this.term.attachCustomKeyEventHandler(() => true)
    this.term = null
  }

  /** Register a rule; the returned function unregisters it. */
  register(rule: KeyInterceptRule): () => void {
    this.rules = this.rules.filter((r) => r.id !== rule.id)
    this.rules.push(rule)
    return () => {
      this.rules = this.rules.filter((r) => r !== rule)
    }
  }

  private readonly onEvent = (ev: KeyboardEvent): boolean => {
    // The handler also sees keyup/keypress; only keydown decides anything.
    if (ev.type !== 'keydown') return true
    for (const rule of this.rules) {
      if (rule.handle(ev)) {
        ev.preventDefault()
        return false
      }
    }
    return true
  }
}
