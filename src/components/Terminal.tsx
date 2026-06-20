import React, { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { connect, sendInput, pollOutput } from '../commands';

interface TerminalComponentProps {
  tabId: string;
  isActive: boolean;
  connectConfig?: {
    host: string;
    port: number;
    username: string;
    password?: string;
    keyPath?: string;
  };
  autoConnect: boolean;
  onStatusChange: (status: 'connecting' | 'connected' | 'error' | 'disconnected', errorMessage?: string) => void;
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
  const connectConfigRef = useRef(connectConfig);
  const onStatusChangeRef = useRef(onStatusChange);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasRun = useRef(false);

  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);
  useEffect(() => { tabIdRef.current = tabId; }, [tabId]);
  useEffect(() => { connectConfigRef.current = connectConfig; });
  useEffect(() => { onStatusChangeRef.current = onStatusChange; });

  // Create terminal + start connection + poll output
  useEffect(() => {
    console.log('[Terminal] effect running, containerRef=', !!containerRef.current, 'autoConnect=', autoConnect, 'hasRun=', hasRun.current);
    if (!containerRef.current || !autoConnect || hasRun.current) {
      console.log('[Terminal] effect early return');
      return;
    }
    hasRun.current = true;

    const cfg = connectConfigRef.current;
    console.log('[Terminal] connectConfig=', cfg);
    if (!cfg) { console.log('[Terminal] no cfg, return'); return; }

    const currentTabId = tabIdRef.current;

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

    // User input → SSH
    term.onData((data) => {
      if (!isActiveRef.current) return;
      sendInput(currentTabId, data).catch(err => console.error('send_input error:', err));
    });

    // Focus on click
    const handleClick = () => {
      if (isActiveRef.current) term.focus();
    };
    containerRef.current.addEventListener('click', handleClick);

    // Window resize
    const handleResize = () => {
      if (isActiveRef.current && fitRef.current) {
        fitRef.current.fit();
      }
    };
    window.addEventListener('resize', handleResize);

    // Poll SSH output (every 100ms), completely bypassing Tauri event system
    const startPolling = () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = setInterval(async () => {
        try {
          const chunks = await pollOutput(currentTabId);
          if (chunks.length > 0) {
            for (const chunk of chunks) {
              term.write(chunk);
            }
          }
        } catch {
          // Silently ignore polling failures to avoid spam
        }
      }, 100);
    };

    // Start connection, begin polling after connected
    (async () => {
      onStatusChangeRef.current('connecting');
      try {
        await connect({
          id: '',
          name: `${cfg.username}@${cfg.host}`,
          host: cfg.host,
          port: cfg.port,
          username: cfg.username,
          password: cfg.password,
          keyPath: cfg.keyPath,
        }, currentTabId);
        onStatusChangeRef.current('connected');
        // Start polling output immediately after connection succeeds
        startPolling();
      } catch (err) {
        const errMsg = typeof err === 'string' ? err : (err as any)?.message || String(err);
        onStatusChangeRef.current('error', errMsg);
        console.error('connect error:', err);
      }
    })();

    return () => {
      console.log('[Terminal] cleanup, resetting hasRun');
      hasRun.current = false;
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      containerRef.current?.removeEventListener('click', handleClick);
      window.removeEventListener('resize', handleResize);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect]);

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
