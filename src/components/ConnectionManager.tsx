import React, { useState, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { ConnectionConfig } from '../types';
import { saveConnection as saveConn, deleteConnection } from '../commands';

interface ConnectionManagerProps {
  connections: ConnectionConfig[];
  onConnect: (config: ConnectionConfig, tabId: string) => void;
  onTabClosed: (tabId: string) => void;
  activeTabId: string | null;
  onConnectionChange: () => void;
  onSelectConnection: (config: ConnectionConfig) => void;
}

export const ConnectionManager: React.FC<ConnectionManagerProps> = ({
  connections,
  onConnect,
  onTabClosed,
  activeTabId,
  onConnectionChange,
  onSelectConnection,
}) => {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<ConnectionConfig | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; conn: ConnectionConfig } | null>(null);

  const handleEdit = (conn: ConnectionConfig) => {
    setEditing(conn);
    setShowModal(true);
  };

  const handleDelete = async (conn: ConnectionConfig) => {
    if (confirm(`Are you sure you want to delete "${conn.name}"?`)) {
      await deleteConnection(conn.id);
      onConnectionChange();
    }
    setContextMenu(null);
  };

  return (
    <>
      <div className="sidebar">
        <div className="sidebar-header">
          <span>Connections</span>
          <button onClick={() => { setEditing(null); setShowModal(true); }} style={{
            background: 'none', border: 'none', color: '#007acc', cursor: 'pointer', fontSize: '16px'
          }}>
            +
          </button>
        </div>
        <div className="sidebar-list">
          {connections.length === 0 ? (
            <div className="empty-state">
              <div>🖥️</div>
              <div>No connections yet</div>
              <div style={{ fontSize: '12px', marginTop: '8px' }}>
                Click + to add a new SSH connection
              </div>
            </div>
          ) : (
            connections.map(conn => (
              <div
                key={conn.id}
                className="connection-item"
                onClick={() => onSelectConnection(conn)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, conn });
                }}
              >
                <span className="conn-icon">🔗</span>
                <div className="conn-info">
                  <div className="conn-name">{conn.name}</div>
                  <div className="conn-host">{conn.host}:{conn.port}</div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {showModal && (
        <ConnectionModal
          connection={editing}
          onClose={() => { setShowModal(false); setEditing(null); }}
          onSave={(config) => {
            saveConn(config);
            onConnectionChange();
            setShowModal(false);
            setEditing(null);
          }}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onEdit={() => { handleEdit(contextMenu.conn); setContextMenu(null); }}
          onDelete={() => handleDelete(contextMenu.conn)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
};

// ===== Connection Edit Modal =====

interface ConnectionModalProps {
  connection: ConnectionConfig | null;
  onClose: () => void;
  onSave: (config: ConnectionConfig) => void;
}

export const ConnectionModal: React.FC<ConnectionModalProps> = ({ connection, onClose, onSave }) => {
  const [name, setName] = useState(connection?.name || '');
  const [host, setHost] = useState(connection?.host || '');
  const [port, setPort] = useState(connection?.port || 22);
  const [username, setUsername] = useState(connection?.username || '');
  const [authType, setAuthType] = useState<'password' | 'key'>(
    connection && connection.password ? 'password' : 'password'
  );
  const [password, setPassword] = useState(connection?.password || '');
  const [keyPath, setKeyPath] = useState(connection?.keyPath || '');
  const [passphrase, setPassphrase] = useState(connection?.passphrase || '');

  const handleSave = () => {
    if (!name || !host || !username) {
      alert('Please fill in name, host, and username');
      return;
    }
    const config: ConnectionConfig = {
      id: connection?.id || uuidv4(),
      name,
      host,
      port,
      username,
      password: authType === 'password' ? password : undefined,
      keyPath: authType === 'key' ? keyPath : undefined,
      passphrase: authType === 'key' ? passphrase || undefined : undefined,
    };
    onSave(config);
  };

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal-header">
          <h3>{connection ? 'Edit Connection' : 'New Connection'}</h3>
          <span onClick={onClose} style={{ cursor: 'pointer', fontSize: '18px', color: '#888' }}>✕</span>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Server" />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Host</label>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.100" />
            </div>
            <div className="form-group">
              <label>Port</label>
              <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} placeholder="22" />
            </div>
          </div>
          <div className="form-group">
            <label>Username</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />
          </div>

          <div className="auth-type-toggle">
            <label>
              <input
                type="radio"
                checked={authType === 'password'}
                onChange={() => setAuthType('password')}
              />
              Password
            </label>
            <label>
              <input
                type="radio"
                checked={authType === 'key'}
                onChange={() => setAuthType('key')}
              />
              SSH Key
            </label>
          </div>

          {authType === 'password' ? (
            <div className="form-group">
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
              />
            </div>
          ) : (
            <>
              <div className="form-group">
                <label>Key Path</label>
                <input
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                  placeholder="~/.ssh/id_rsa"
                />
              </div>
              <div className="form-group">
                <label>Passphrase (optional)</label>
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Key passphrase"
                />
              </div>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-cancel" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSave}>
            {connection ? 'Update' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ===== Context Menu =====

interface ContextMenuProps {
  x: number;
  y: number;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}

const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, onEdit, onDelete, onClose }) => {
  React.useEffect(() => {
    const handler = () => onClose();
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [onClose]);

  return (
    <div
      className="context-menu"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="context-menu-item" onClick={onEdit}>✏️ Edit</div>
      <div className="context-menu-item" onClick={onDelete}>🗑️ Delete</div>
    </div>
  );
};
