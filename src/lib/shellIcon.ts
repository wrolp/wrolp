import type { IconName } from '../components/Icon'

/**
 * The icon for a saved local-terminal entry or a local-shell tab.
 *
 * The five shell flavours are each a terminal window carrying a distinguishing
 * mark, so they stay recognisable as terminals while still telling cmd /
 * PowerShell / bash / WSL / Git Bash apart at 14px. `shell` is whatever the entry
 * stores — a bare keyword or a full path — so this matches the keywords first,
 * then the path shapes most specific first, and falls back to the generic
 * terminal icon.
 */
export function shellIconName(shell: string): IconName {
  const s = shell.trim().toLowerCase()
  if (!s) return 'terminal'
  switch (s) {
    case 'cmd':
      return 'shellCmd'
    case 'pwsh':
    case 'powershell':
      return 'shellPowershell'
    case 'bash':
      return 'shellBash'
    case 'wsl':
      return 'shellWsl'
    case 'gitbash':
      return 'shellGitBash'
  }
  if (s.includes('git-bash') || s.includes('git\\bin\\bash') || s.includes('git/usr/bin/bash')) {
    return 'shellGitBash'
  }
  if (s.includes('wsl')) return 'shellWsl'
  if (s.includes('pwsh') || s.includes('powershell')) return 'shellPowershell'
  if (s.includes('cmd.exe') || s.endsWith('cmd')) return 'shellCmd'
  if (s.includes('bash') || s.includes('zsh') || s.endsWith('sh.exe')) return 'shellBash'
  return 'terminal'
}
