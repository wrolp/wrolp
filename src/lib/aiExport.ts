// Plain-text serializers for AI conversations — one source of truth for both
// "copy the conversation" (clipboard) and "export to a file" (the backend only
// writes the string the dialog picked a path for). Markdown is the human format;
// JSON is the lossless format (the raw durable message objects).

import type { AiStoredMessage } from '../types'

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/** Render a conversation as a readable Markdown transcript. */
export function aiSessionMarkdown(
  messages: AiStoredMessage[],
  title: string,
  connectionName?: string | null,
): string {
  const lines: string[] = [`# ${title.trim() || 'Untitled'}`, '']
  if (connectionName) {
    lines.push(`> Connection: ${connectionName}`, '')
  }
  for (const m of messages) {
    lines.push(`## ${m.role === 'user' ? 'User' : 'Assistant'}`, '')
    if (m.images && m.images.length) {
      lines.push(
        `*(${m.images.length} attached image${m.images.length === 1 ? '' : 's'} omitted)*`,
        '',
      )
    }
    if (m.content) {
      lines.push(m.content, '')
    }
    for (const tc of m.toolCalls ?? []) {
      lines.push(`### Tool: ${tc.name}`, '', '```json', prettyJson(tc.arguments), '```', '')
      if (tc.result) {
        lines.push('Result:', '', '```', tc.result, '```', '')
      } else if (tc.error) {
        lines.push('Error:', '', '```', tc.error, '```', '')
      }
    }
  }
  return lines.join('\n').trimEnd() + '\n'
}

/** Render a conversation as a pretty JSON document (lossless). */
export function aiSessionJson(
  messages: AiStoredMessage[],
  title: string,
  connectionName?: string | null,
): string {
  return (
    JSON.stringify(
      {
        title: title.trim() || null,
        connectionName: connectionName ?? null,
        exportedAt: new Date().toISOString(),
        messages,
      },
      null,
      2,
    ) + '\n'
  )
}
