import React, { useEffect, useRef, useCallback } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import 'xterm/css/xterm.css';
import type { TerminalOutput } from '../types';

interface TerminalComponentProps {
  tabId: string;
  isActive: boolean;
  // Connection params — passed from parent to trigger connection
  connectConfig?: {
    host: string;
    port: number;
    username: string;
    password?: string;
    keyPath?: string;
  };
  // Whether to auto-connect
  autoConnect: boolean;
  onStatusChange: (status: 'connecting' | 'connected' | 'error' | 'disconnected') => void;
}

export const TerminalComponent: React.FC<TerminalComponentProps> = ({
  tabId,
  isActive,
  connectConfig,
  autoConnect,
  onStatusChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const isActiveRef = useRef(isActive);
  const tabIdRef = useRef(tabId);
  const unlistenRef = useRef<(() => void) | null>(null);

  // Keep refs in sync with props
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  useEffect(() => {
    tabIdRef.current = tabId;
  }, [tabId]);

  // Listen for terminal output events
  const setupListener = useCallback(async (term: Terminal, currentTabId: string) => {
    if (unlistenRef.current) {
      try { unlistenRef.current(); } catch {}
    }
    const unlisten = await listen<TerminalOutput>('ssh://output', (event) => {
      const payload = event.payload;
      if (payload.tabId === currentTabId) {
        term.write(payload.data);
      }
    });
    unlistenRef.current = unlisten as unknown as () => void;
  }, []);

  // Start SSH connection
  const startConnection = useCallback(async (term: Terminal, currentTabId: string, cfg: TerminalComponentProps['connectConfig']) => {
    if (!cfg) return;

    onStatusChange('connecting');

    try {
      const result = await invoke('connect', {
        config: {
          id: '', // Temporary ID, not needed for connect command
          name: `${cfg.username}@${cfg.host}`,
          host: cfg.host,
          port: cfg.port,
          username: cfg.username,
          password: cfg.password,
          keyPath: cfg.keyPath,
        },
        tab_id: currentTabId,
      });
      // connect returns a JSON string on success
      const parsed = JSON.parse(result as string);
      if (parsed.status === 'connected') {
        onStatusChange('connected');
      }
    } catch (err) {
      onStatusChange('error');
      console.error('connect error:', err);
    }
  }, [onStatusChange]);

  useEffect(() => {
    if (!containerRef.current || !connectConfig || !autoConnect) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Fira Code", "Cascadia Code", Consolas, "Courier New", monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#aeafad',
        selectionBackground: '#264f78',
        black: '#1e1e1e',
        red: '#f44747',
        green: '#6a9955',
        yellow: '#dcdcaa',
        blue: '#569cd6',
        magenta: '#c586c0',
        cyan: '#4dc9b0',
        white: '#d4d4d4',
        brightBlack: '#808080',
        brightRed: '#f44747',
        brightGreen: '#6a9955',
        brightYellow: '#dcdcaa',
        brightBlue: '#569cd6',
        brightMagenta: '#c586c0',
        brightCyan: '#4dc9b0',
        brightWhite: '#ffffff',
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

    // Set up event listener
    setupListener(term, tabIdRef.current);

    // Use xterm onData to receive user input
    term.onData((data) => {
      if (!isActiveRef.current) return;
      invoke('send_input', { tab_id: tabIdRef.current, data })
        .catch(err => console.error('send_input error:', err));
    });

    // Focus terminal on click
    const handleClick = () => {
      if (isActive) term.focus();
    };
    containerRef.current.addEventListener('click', handleClick);

    // Auto-fit on window resize
    const handleResize = () => {
      if (isActive && fitRef.current) {
        fitRef.current.fit();
      }
    };
    window.addEventListener('resize', handleResize);

    // Auto connect
    startConnection(term, tabIdRef.current, connectConfig);

    return () => {
      unlistenRef.current?.();
      containerRef.current?.removeEventListener('click', handleClick);
      window.removeEventListener('resize', handleResize);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [tabId, connectConfig, autoConnect, isActive, setupListener, startConnection]);

  // Focus when tab becomes active
  useEffect(() => {
    if (isActive && termRef.current) {
      termRef.current.focus();
    }
  }, [isActive]);

  return (
    <div
      ref={containerRef}
      style={{ height: '100%', width: '100%' }}
    />
  );
};
