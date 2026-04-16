/**
 * QuakeTerminal - Slide-down terminal with xterm.js
 */

import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export const QuakeTerminal: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectDelayRef = useRef<number>(1000); // Start at 1 second
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Initialize terminal on mount
    if (!terminalRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'JetBrains Mono, Fira Code, Cascadia Code, monospace',
      theme: {
        background: '#0c0a09',
        foreground: '#fef3c7',
        cursor: '#d97706',
        selection: 'rgba(217, 119, 6, 0.3)',
        black: '#0c0a09',
        red: '#ef4444',
        green: '#10b981',
        yellow: '#f59e0b',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#fef3c7',
        brightBlack: '#78716c',
        brightRed: '#f87171',
        brightGreen: '#34d399',
        brightYellow: '#fbbf24',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#fffbeb',
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalRef.current);

    terminalInstanceRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Handle terminal input
    terminal.onData((data) => {
      if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
        socketRef.current.send(data);
      }
    });

    return () => {
      terminal.dispose();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (socketRef.current) {
        socketRef.current.close();
      }
    };
  }, []);

  useEffect(() => {
    if (isOpen && terminalInstanceRef.current && fitAddonRef.current) {
      // Fit terminal when opened
      setTimeout(() => {
        fitAddonRef.current?.fit();
        if (
          socketRef.current &&
          socketRef.current.readyState === WebSocket.OPEN &&
          terminalInstanceRef.current
        ) {
          socketRef.current.send(
            JSON.stringify({
              type: 'resize',
              cols: terminalInstanceRef.current.cols,
              rows: terminalInstanceRef.current.rows,
            })
          );
        }
      }, 100);

      // Connect WebSocket if not connected
      if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
        connectWebSocket();
      }

      // Focus terminal
      terminalInstanceRef.current.focus();
    }
  }, [isOpen]);

  const connectWebSocket = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/term`;

    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;

    socket.onopen = () => {
      console.log('[term] Connected');
      // Reset reconnection delay on successful connection
      reconnectDelayRef.current = 1000;
      if (terminalInstanceRef.current) {
        terminalInstanceRef.current.write('\r\n\x1b[32m[Terminal connected]\x1b[0m\r\n');
        // Send initial resize
        socket.send(
          JSON.stringify({
            type: 'resize',
            cols: terminalInstanceRef.current.cols,
            rows: terminalInstanceRef.current.rows,
          })
        );
      }
    };

    socket.onmessage = (event) => {
      if (terminalInstanceRef.current) {
        if (event.data instanceof Blob) {
          event.data.arrayBuffer().then((buffer) => {
            const uint8Array = new Uint8Array(buffer);
            terminalInstanceRef.current?.write(uint8Array);
          });
        } else if (event.data instanceof ArrayBuffer) {
          const uint8Array = new Uint8Array(event.data);
          terminalInstanceRef.current?.write(uint8Array);
        } else {
          terminalInstanceRef.current?.write(event.data);
        }
      }
    };

    socket.onerror = (error) => {
      console.error('[term] WebSocket error:', error);
      if (terminalInstanceRef.current) {
        terminalInstanceRef.current.write('\r\n\x1b[31m[Connection error]\x1b[0m\r\n');
      }
    };

    socket.onclose = () => {
      console.log('[term] WebSocket closed');
      if (terminalInstanceRef.current && isOpen) {
        terminalInstanceRef.current.write('\r\n\x1b[33m[Connection closed]\x1b[0m\r\n');
      }
      socketRef.current = null;

      // Attempt reconnection with exponential backoff if terminal is open
      if (isOpen) {
        const delay = reconnectDelayRef.current;
        console.log(`[term] Reconnecting in ${delay}ms...`);
        if (terminalInstanceRef.current) {
          terminalInstanceRef.current.write(
            `\r\n\x1b[33m[Reconnecting in ${delay / 1000}s...]\x1b[0m\r\n`
          );
        }

        reconnectTimeoutRef.current = setTimeout(() => {
          connectWebSocket();
          // Increase delay exponentially, max 8 seconds
          reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 8000);
        }, delay);
      }
    };
  };

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      if (terminalInstanceRef.current && fitAddonRef.current && isOpen) {
        fitAddonRef.current.fit();
        if (
          socketRef.current &&
          socketRef.current.readyState === WebSocket.OPEN &&
          terminalInstanceRef.current
        ) {
          socketRef.current.send(
            JSON.stringify({
              type: 'resize',
              cols: terminalInstanceRef.current.cols,
              rows: terminalInstanceRef.current.rows,
            })
          );
        }
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isOpen]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Backtick (`) to toggle - don't trigger if in input/textarea
      if (e.key === '`' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
          e.preventDefault();
          setIsOpen((prev) => !prev);
        }
      }

      // ESC to close terminal
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  return (
    <>
      <div className={`quake-terminal ${isOpen ? 'open' : ''}`}>
        <div id="quake-terminal-bar">
          <span>❯_ Terminal</span>
          <button onClick={() => setIsOpen(false)} title="Close terminal">
            ✕
          </button>
        </div>
        <div ref={terminalRef} id="term-container" />
      </div>
    </>
  );
};
