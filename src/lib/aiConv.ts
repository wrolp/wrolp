import type { AiConv } from '../aiChatRun'

/**
 * A fresh AI conversation.
 *
 * Shared because two windows can own one: the main window (per shell tab and for
 * the inspector column) and a float window's own AI panel. Keeping the shape in
 * one place is what makes a conversation created on either side acceptable to the
 * other.
 */
export function emptyAiConv(): AiConv {
  return {
    sessionId: crypto.randomUUID(),
    sessionTitle: '',
    messages: [],
    input: '',
    streaming: false,
    streamingText: '',
    error: null,
    toolCalls: [],
    showSuggestions: true,
    toolCallFormat: 'nested',
    mode: 'command',
    flow: null,
    run: null,
  }
}
