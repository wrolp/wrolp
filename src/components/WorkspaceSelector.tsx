import React, { useState, useRef, useEffect } from 'react'
import { Icon } from './Icon'
import type { WorkspaceInfo } from '../types'

interface Props {
  workspaces: WorkspaceInfo[]
  activeId: string
  onSwitch: (id: string) => void
  onCreate: (name: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
}

export const WorkspaceSelector: React.FC<Props> = ({
  workspaces,
  activeId,
  onSwitch,
  onCreate,
  onDelete,
  onRename,
}) => {
  const [open, setOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [creating, setCreating] = useState(false)
  const [createValue, setCreateValue] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)
  const createInputRef = useRef<HTMLInputElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  const activeName = workspaces.find((w) => w.id === activeId)?.name ?? activeId

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
        setCreating(false)
        setRenamingId(null)
      }
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Focus create input
  useEffect(() => {
    if (creating) createInputRef.current?.focus()
  }, [creating])

  // Focus rename input
  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus()
  }, [renamingId])

  const submitCreate = () => {
    const name = createValue.trim()
    if (name) {
      onCreate(name)
      setCreateValue('')
      setCreating(false)
    }
  }

  const submitRename = () => {
    const name = renameValue.trim()
    if (name && renamingId) {
      onRename(renamingId, name)
      setRenamingId(null)
      setRenameValue('')
    }
  }

  return (
    <div className="workspace-selector" ref={menuRef}>
      <button
        className="workspace-selector-trigger"
        onClick={() => setOpen(!open)}
        title="Switch workspace"
      >
        <span className="workspace-icon"><Icon name="folder" size={15} /></span>
        <span className="workspace-name">{activeName}</span>
        <span className={`workspace-chevron ${open ? 'open' : ''}`}>&#9662;</span>
      </button>
      {open && (
        <div className="workspace-dropdown">
          {workspaces.map((ws) => (
            <div
              key={ws.id}
              className={`workspace-item ${ws.id === activeId ? 'active' : ''}`}
            >
              {renamingId === ws.id ? (
                <input
                  ref={renameInputRef}
                  className="workspace-rename-input"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitRename()
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                  onBlur={submitRename}
                />
              ) : (
                <>
                  <span
                    className="workspace-item-label"
                    onClick={() => {
                      if (ws.id !== activeId) {
                        onSwitch(ws.id)
                        setOpen(false)
                      }
                    }}
                  >
                    {ws.name}
                  </span>
                  <div className="workspace-item-actions">
                    <button
                      className="workspace-action-btn"
                      title="Rename"
                      onClick={(e) => {
                        e.stopPropagation()
                        setRenamingId(ws.id)
                        setRenameValue(ws.name)
                      }}
                    >
                      ✎
                    </button>
                    {ws.id !== 'default' && (
                      <button
                        className="workspace-action-btn workspace-action-del"
                        title="Delete"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (confirm(`Delete workspace "${ws.name}" and all its connections? This cannot be undone.`)) {
                            onDelete(ws.id)
                            if (ws.id === activeId) setOpen(false)
                          }
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
          <div className="workspace-divider" />
          {creating ? (
            <div className="workspace-create-row">
              <input
                ref={createInputRef}
                className="workspace-create-input"
                value={createValue}
                onChange={(e) => setCreateValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitCreate()
                  if (e.key === 'Escape') {
                    setCreating(false)
                    setCreateValue('')
                  }
                }}
                onBlur={() => {
                  submitCreate()
                }}
                placeholder="Workspace name"
              />
            </div>
          ) : (
            <button
              className="workspace-create-btn"
              onClick={() => setCreating(true)}
            >
              + New Workspace
            </button>
          )}
        </div>
      )}
    </div>
  )
}
