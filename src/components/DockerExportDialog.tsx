import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FileEntry } from '../types'
import { fsListFiles } from '../commands'
import { isDismissKey } from '../lib/keybindings'
import { useI18n } from '../i18n'
import { Icon } from './Icon'

interface DockerExportDialogProps {
  /** The SSH session whose daemon answers; its filesystem is where server paths live. */
  jumpTabId: number
  imageRef: string
  /** Display name of the daemon host (`web:22`), used in the hint. */
  serverLabel?: string
  /** Download to this computer: native save picker plus the streamed transfer. */
  onDownload: () => Promise<void> | void
  /** `docker save -o <path>` on the daemon host; rejects on failure. */
  onSaveToHost: (path: string) => Promise<void>
  onClose: () => void
}

/** Split a path into its directory and the segment after the last `/`. */
function splitExportPath(value: string): { dir: string; tail: string } {
  const trimmed = value.trim()
  const cut = trimmed.lastIndexOf('/')
  if (cut < 0) return { dir: '', tail: trimmed }
  return { dir: trimmed.slice(0, cut) || '/', tail: trimmed.slice(cut + 1) }
}

function joinExportPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

function parentExportDir(dir: string): string {
  if (!dir || dir === '/') return '/'
  const cut = dir.lastIndexOf('/')
  return cut <= 0 ? '/' : dir.slice(0, cut)
}

/**
 * Pick where an image tar goes when the daemon is on a jump host: written by the
 * server itself (`docker save -o`, the path combobox lists that machine's
 * directories) or streamed back to this computer. A local daemon skips this
 * dialog — there the native save picker already is the local path picker.
 *
 * The combobox's list is portaled to <body>: the dialog body scrolls, and an
 * absolutely positioned list inside it was clipped at the modal's edge. A path
 * ending in `/` is a directory, and the export names the tar after the image.
 */
export function DockerExportDialog({
  jumpTabId,
  imageRef,
  serverLabel,
  onDownload,
  onSaveToHost,
  onClose,
}: DockerExportDialogProps) {
  const { t } = useI18n()
  const safeName = `${imageRef.replace(/[<>:"/\\|?*\s]+/g, '-')}.tar`
  const [mode, setMode] = useState<'host' | 'local'>('host')
  const [path, setPath] = useState('/tmp/')
  const [showList, setShowList] = useState(false)
  const [dirs, setDirs] = useState<FileEntry[] | null>(null)
  const [listing, setListing] = useState(false)
  const [listError, setListError] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const requestRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)

  const { dir, tail } = splitExportPath(path)
  const listDir = dir || '/'
  const needle = tail.toLowerCase()
  const filteredDirs = (dirs ?? []).filter(
    (row) => !needle || row.name.toLowerCase().startsWith(needle),
  )
  const trimmedPath = path.trim()
  const resolvedPath = trimmedPath.endsWith('/') ? `${trimmedPath}${safeName}` : trimmedPath

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isDismissKey(e)) return
      // Escape closes the open list before it closes the whole dialog.
      if (showList) {
        setShowList(false)
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, showList])

  // List the directory part of the typed path while the combobox is open. The
  // debounce keeps typing from listing every intermediate directory, and the
  // request id drops answers that arrive after a newer one was asked for.
  useEffect(() => {
    if (mode !== 'host' || !showList) return
    const id = ++requestRef.current
    setListing(true)
    setListError('')
    const timer = window.setTimeout(() => {
      fsListFiles({ kind: 'session', tabId: jumpTabId }, listDir)
        .then((rows) => {
          if (id !== requestRef.current) return
          setDirs(rows.filter((row) => row.isDir).sort((a, b) => a.name.localeCompare(b.name)))
        })
        .catch((e) => {
          if (id !== requestRef.current) return
          setDirs([])
          setListError(String(e))
        })
        .finally(() => {
          if (id === requestRef.current) setListing(false)
        })
    }, 180)
    return () => window.clearTimeout(timer)
  }, [mode, showList, listDir, jumpTabId])

  // Dismiss on an outside click or any scroll/resize: the list is fixed-positioned
  // against the input's rect, and a scrolled dialog would leave it detached.
  useEffect(() => {
    if (!showList || mode !== 'host') return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (target && (inputRef.current?.contains(target) || menuRef.current?.contains(target)))
        return
      setShowList(false)
    }
    const onScroll = (e: Event) => {
      const target = e.target as Node | null
      if (target && menuRef.current?.contains(target)) return
      setShowList(false)
    }
    const onResize = () => setShowList(false)
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [showList, mode])

  // Anchor the portaled list to the input, flipping above it when the room below
  // is the smaller side (the same rule as the app's select overlay).
  useLayoutEffect(() => {
    const menu = menuRef.current
    const input = inputRef.current
    if (!showList || mode !== 'host' || !menu || !input) return
    const rect = input.getBoundingClientRect()
    const natural = menu.getBoundingClientRect().height
    const roomBelow = window.innerHeight - rect.bottom - 12
    const roomAbove = rect.top - 12
    const below = natural <= roomBelow || roomBelow >= roomAbove
    const room = Math.max(120, below ? roomBelow : roomAbove)
    menu.style.left = `${rect.left}px`
    menu.style.width = `${rect.width}px`
    menu.style.maxHeight = `${room}px`
    const height = Math.min(natural, room)
    menu.style.top = `${below ? rect.bottom + 2 : Math.max(8, rect.top - height - 2)}px`
  }, [showList, mode, path, listing, listError, dirs])

  /** Navigate into a directory: the path becomes a directory path and the
   *  dropdown lists its children, so the file name is typed last. */
  const browseInto = (name: string) => {
    setDirs(null)
    setPath(`${joinExportPath(listDir, name)}/`)
  }

  const browseUp = () => {
    setDirs(null)
    const up = parentExportDir(listDir)
    setPath(up === '/' ? '/' : `${up}/`)
  }

  const submit = async () => {
    if (busy) return
    setError('')
    if (mode === 'host' && !resolvedPath) {
      setError(t('dockerExportPathRequired'))
      return
    }
    setBusy(true)
    try {
      if (mode === 'host') await onSaveToHost(resolvedPath)
      else await onDownload()
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const suggestions =
    showList && mode === 'host' && !busy ? (
      <ul
        ref={menuRef}
        className="docker-export-suggestions"
        role="listbox"
        aria-label={t('dockerExportDirList')}
        onMouseDown={(e) => e.preventDefault()}
      >
        {listing && !dirs && <li className="docker-export-list-note">{t('loading')}</li>}
        {listError && (
          <li className="docker-export-list-note">
            {t('dockerExportDirFailed', { err: listError })}
          </li>
        )}
        {!listError && dirs && (
          <>
            {listDir !== '/' && (
              <li role="option" aria-selected={false} onClick={browseUp}>
                <Icon name="folder" size={13} />
                <span>..</span>
              </li>
            )}
            {filteredDirs.map((row) => (
              <li
                key={row.name}
                role="option"
                aria-selected={false}
                onClick={() => browseInto(row.name)}
              >
                <Icon name="folder" size={13} />
                <span>{row.name}/</span>
              </li>
            ))}
            {filteredDirs.length === 0 && (
              <li className="docker-export-list-note">
                {needle ? t('dockerExportNoMatches') : t('dockerExportNoSubdirs')}
              </li>
            )}
          </>
        )}
      </ul>
    ) : null

  return (
    <div className="modal-overlay">
      <div className="modal docker-export-dialog">
        <div className="modal-header">
          <h3>{t('dockerExportDialogTitle')}</h3>
        </div>
        <div className="modal-body">
          <div className="docker-export-image" title={imageRef}>
            {imageRef}
          </div>

          <div className="docker-export-option">
            <input
              id="docker-export-host"
              type="radio"
              checked={mode === 'host'}
              onChange={() => setMode('host')}
            />
            <div className="docker-export-option-body">
              <label htmlFor="docker-export-host" className="docker-export-option-title">
                {t('dockerExportToHost')}
              </label>
              <span className="docker-export-hint">
                {t('dockerExportToHostHint', { host: serverLabel ?? `#${jumpTabId}` })}
              </span>
              {mode === 'host' && (
                <div className="docker-export-path">
                  <input
                    ref={inputRef}
                    className="file-modal-input docker-export-path-input"
                    value={path}
                    onChange={(e) => {
                      setPath(e.target.value)
                      setShowList(true)
                    }}
                    onFocus={() => setShowList(true)}
                    onClick={() => setShowList(true)}
                    aria-label={t('dockerExportPathLabel')}
                    placeholder="/opt/images/"
                    spellCheck={false}
                    autoComplete="off"
                    disabled={busy}
                  />
                  {trimmedPath.endsWith('/') && (
                    <span className="docker-export-hint">
                      {t('dockerExportAutoName', { path: resolvedPath })}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="docker-export-option">
            <input
              id="docker-export-local"
              type="radio"
              checked={mode === 'local'}
              onChange={() => setMode('local')}
            />
            <div className="docker-export-option-body">
              <label htmlFor="docker-export-local" className="docker-export-option-title">
                {t('dockerExportToLocal')}
              </label>
              <span className="docker-export-hint">{t('dockerExportToLocalHint')}</span>
            </div>
          </div>

          {error && <div className="file-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn-cancel" onClick={onClose} disabled={busy}>
            {t('cancel')}
          </button>
          <button className="btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? t('dockerExportBusy') : t('dockerExportStart')}
          </button>
        </div>
      </div>
      {suggestions && createPortal(suggestions, document.body)}
    </div>
  )
}

export default DockerExportDialog
