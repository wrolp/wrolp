import React, { useRef, useState } from 'react'
import { FilePanel, type FilePanelBrowseState, type FileTreeHandle } from './FilePanel'
import type { FileTargetMode, TargetRef } from '../types'
import { fsUploadFile, fsUploadLocalDir, fsDownloadFile, fsDownloadDirectory } from '../commands'
import { addTransferRows, updateTransferRows, type TransferRow } from '../lib/transferQueue'
import { Icon } from './Icon'
import { useI18n } from '../i18n'

/**
 * The dual-pane file view (v8-P5): local on the left, the session/jump/docker
 * target on the right, and the seam between them is the transfer action.
 *
 * It is a main-area overlay rather than a mode-column layout because the column
 * is 264px — the design's two panes need the width the terminals have. Two real
 * `FilePanel`s are mounted (one per target) instead of a second, parallel file
 * component: both sides keep their own browsing, selection and dialogs, and the
 * only thing this view adds is the pair of buttons that moves a selection across.
 */

function join(p: string, name: string): string {
  const base = p.endsWith('/') ? p : p + '/'
  return base + name
}

/** The tab a transfer on `t` is reported under — pause and cancel are per-tab. */
const transferTabOf = (t: TargetRef): number | undefined =>
  t.kind === 'session' ? t.tabId : 'jumpTabId' in t ? t.jumpTabId : undefined

export interface DualFilePaneProps {
  tabId: number
  /** Right-hand target. `null` means the tab's own session. */
  remoteTarget?: TargetRef | null
  fileMode?: FileTargetMode
  onFileModeChange?: (mode: FileTargetMode) => void
  onSelectTarget?: (target: TargetRef | null) => void
  hasSession?: boolean
  serverLabel?: string
  onEditFile?: (target: TargetRef, path: string) => void
  onClose: () => void
}

export const DualFilePane: React.FC<DualFilePaneProps> = ({
  tabId,
  remoteTarget,
  fileMode = 'ssh',
  onFileModeChange,
  onSelectTarget,
  hasSession = true,
  serverLabel,
  onEditFile,
  onClose,
}) => {
  const { t } = useI18n()
  const [local, setLocal] = useState<FilePanelBrowseState>({ path: '', selected: [] })
  const [remote, setRemote] = useState<FilePanelBrowseState>({ path: '', selected: [] })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const localRef = useRef<FileTreeHandle>(null)
  const remoteRef = useRef<FileTreeHandle>(null)

  const remoteFs: TargetRef = remoteTarget ?? { kind: 'session', tabId }
  const localFs: TargetRef = { kind: 'local', tabId }
  const transferTabId = transferTabOf(remoteFs)

  const patchRow = (key: string, patch: Partial<TransferRow>) => {
    updateTransferRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }

  /**
   * Move the source pane's selection into the destination pane's directory.
   * Rows go to the app-wide queue, so the drawer's transfer tab shows them even
   * after this view closes — the reason the seam doesn't own a progress list.
   */
  const transfer = async (dir: 'up' | 'down') => {
    const src = dir === 'up' ? local : remote
    const dst = dir === 'up' ? remote : local
    if (src.selected.length === 0 || dst.path.length === 0) return
    setError('')
    setBusy(true)
    const rows: TransferRow[] = src.selected.map((item) => {
      const norm = item.path.replace(/\\/g, '/')
      const name = item.isDir ? `${item.name}/` : item.name
      return dir === 'up'
        ? {
            key: item.isDir ? `upload-dir:${norm}` : `upload:${norm}`,
            filename: name,
            op: 'upload',
            status: 'queued',
            transferred: 0,
            total: 0,
            speed: '',
            tabId: transferTabId,
          }
        : {
            key: item.isDir ? `directory:${item.path}` : `download:${item.path}`,
            filename: name,
            op: item.isDir ? 'directory' : 'download',
            status: 'queued',
            transferred: 0,
            total: 0,
            speed: '',
            tabId: transferTabId,
          }
    })
    addTransferRows(rows)

    let firstError: string | null = null
    for (let i = 0; i < src.selected.length; i++) {
      const item = src.selected[i]
      const row = rows[i]
      patchRow(row.key, { status: 'active' })
      try {
        if (dir === 'up') {
          if (item.isDir) await fsUploadLocalDir(remoteFs, item.path, dst.path)
          else await fsUploadFile(remoteFs, item.path, join(dst.path, item.name))
        } else if (item.isDir) {
          await fsDownloadDirectory(remoteFs, item.path, dst.path)
        } else {
          await fsDownloadFile(remoteFs, item.path, join(dst.path, item.name))
        }
        patchRow(row.key, { status: 'done' })
      } catch (e) {
        patchRow(row.key, { status: 'error', speed: '' })
        if (!firstError) firstError = `${item.name}: ${e}`
      }
    }
    if (firstError) setError(firstError)
    // Only the destination changed: refresh that directory, not the whole tree.
    if (dir === 'up') remoteRef.current?.refreshDirectory(dst.path)
    else localRef.current?.refreshDirectory(dst.path)
    setBusy(false)
  }

  return (
    <div className="dual-pane">
      <div className="dual-head">
        <span className="dual-title">{t('dualPaneTitle')}</span>
        {error && (
          <span className="dual-error" title={error}>
            {error}
          </span>
        )}
        <button
          type="button"
          className="icon-btn dual-close"
          onClick={onClose}
          title={t('closeDualPane')}
          aria-label={t('closeDualPane')}
        >
          <Icon name="x" size={14} />
        </button>
      </div>

      <div className="dual-body">
        <div className="dual-side">
          <div className="dual-label">{t('dualPaneLocal')}</div>
          <FilePanel
            ref={localRef}
            tabId={tabId}
            isConnected={true}
            hasSession={hasSession}
            targetRef={localFs}
            fileMode="local"
            defaultPath=""
            showTransfers={false}
            onBrowseChange={setLocal}
            onEditFile={onEditFile}
          />
        </div>

        <div className="dual-seam">
          <button
            type="button"
            className="dual-arrow up"
            onClick={() => transfer('up')}
            disabled={local.selected.length === 0 || busy}
            title={local.selected.length === 0 ? t('dualPaneNothingSelected') : t('uploadSelected')}
            aria-label={t('uploadSelected')}
          >
            <Icon name="upload" size={16} />
          </button>
          <button
            type="button"
            className="dual-arrow down"
            onClick={() => transfer('down')}
            disabled={remote.selected.length === 0 || busy}
            title={
              remote.selected.length === 0 ? t('dualPaneNothingSelected') : t('downloadSelected')
            }
            aria-label={t('downloadSelected')}
          >
            <Icon name="download" size={16} />
          </button>
        </div>

        <div className="dual-side">
          <div className="dual-label">{serverLabel ?? t('dualPaneRemote')}</div>
          <FilePanel
            ref={remoteRef}
            tabId={tabId}
            isConnected={true}
            hasSession={hasSession}
            targetRef={remoteFs}
            fileMode={fileMode}
            onFileModeChange={onFileModeChange}
            onSelectTarget={onSelectTarget}
            serverLabel={serverLabel}
            showTransfers={false}
            onBrowseChange={setRemote}
            onEditFile={onEditFile}
          />
        </div>
      </div>
    </div>
  )
}
