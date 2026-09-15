/**
 * Copy text to the clipboard, falling back to a hidden `<textarea>` when the async
 * Clipboard API is unavailable (non-secure contexts / older WebViews).
 *
 * Resolves either way — callers only care that the attempt ran, so they can show their
 * "copied" feedback without an error branch. Shared by the AI chat code blocks and the
 * Markdown preview's code blocks.
 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  } catch {
    // Nothing else we can do — the caller still shows its feedback.
  }
}
