// ---- AI-issued command/output highlight (ai-term-mark) ----
//
// `run_command_on_terminal` types AI commands into the live shell and emits
// `ai-term-mark` begin/end events. xterm's `onData` never fires for backend
// writes, so the command line can't be detected via keystrokes — instead the
// frontend colorizes the output stream itself: bright cyan + bold for the
// echoed command line (up to its first newline), dim cyan for the command's
// output, restoring the default color on `end`. This is a pure output-stream
// rewrite, so it works identically for SSH and ConPTY local shells.

export const AI_CMD_FG = '\x1b[96m\x1b[1m' // bright cyan + bold
export const AI_OUTPUT_FG = '\x1b[2m\x1b[36m' // dim cyan
export const ANSI_RESET = '\x1b[0m'
export const AI_MARK_TIMEOUT_MS = 90_000

/** Truncate a command to a displayable length for the status badge. */
export function truncateCmd(cmd: string, max = 40): string {
  if (cmd.length <= max) return cmd
  return cmd.slice(0, max) + '…'
}

export interface AiMarkState {
  mode: 'cmd' | 'output' | 'done'
  seq: number
  /** The shell prompt captured at `begin` (plain text, as read from the
   *  terminal buffer). Used to detect when the shell redraws it after the
   *  command finishes — at that point we stop tinting so the prompt keeps its
   *  original color instead of inheriting the AI output tint. */
  prompt: string
}

/** Rewrite a chunk's foreground color, dropping any pre-existing SGR color. */
export function colorizeChunk(chunk: string, fg: string): string {
  if (!chunk.includes('\x1b[')) return fg + chunk + ANSI_RESET
  return fg + chunk.replace(/(\x1b\[[0-9;]*m)/g, ANSI_RESET + fg) + ANSI_RESET
}

/** Dim a plain output chunk; pass colored chunks (grep/git) through untouched. */
export function colorizeOutputChunk(chunk: string): string {
  if (chunk.includes('\x1b[')) return chunk
  return AI_OUTPUT_FG + chunk + ANSI_RESET
}
