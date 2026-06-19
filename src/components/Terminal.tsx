import React, { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import 'xterm/css/xterm.css';
import type { TerminalOutput } from '../types';

interface TerminalComponentProps {
  tabId: string;
  isActive: boolean;
}

export const TerminalComponent: React.FC<TerminalComponentProps> = ({ tabId, isActive }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const isActiveRef = useRef(isActive);

  // Keep ref in sync with prop
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  useEffect(() => {
    if (!containerRef.current) return;

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

    // Use xterm onData to receive user input
    term.onData((data) => {
      if (!isActiveRef.current) return;
      invoke('send_input', { tabId, data })
        .catch(err => console.error('send_input error:', err));
    });

    // Listen for terminal output from Rust backend
    const unlistenOutput = listen<TerminalOutput>('ssh://output', (event) => {
      const payload = event.payload;
      if (payload.tabId === tabId) {
        term.write(payload.data);
      }
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

    return () => {
      unlistenOutput.then((fn) => fn());
      containerRef.current?.removeEventListener('click', handleClick);
      window.removeEventListener('resize', handleResize);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [tabId]);

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
