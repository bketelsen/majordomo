/**
 * Majordomo React App Entry Point
 * Phase 2: Functional chat pane with SSE streaming, tool calls, and domain switching
 */

import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { useDomains } from './hooks/useDomains';
import { ChatPane } from './components/ChatPane';
import { DomainTabs } from './components/DomainTabs';

// Atreides Hawk SVG (inline from current UI)
const AtridesHawkIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 512 512">
    <g transform="translate(96, 80) scale(4.03)">
      <path
        fill="#d97706"
        d="m 74.412,20.521 -28.357,29.03 v 13.367 l 6.901,-7.065 v -7.477 l 21.456,-21.965 z"
      />
      <path
        fill="#d97706"
        d="M 0,0 v 13.698 l 34.523,35.343 v 16.79 l 5.165,5.287 5.164,-5.287 v -16.79 L 79.375,13.698 V 0 L 39.688,40.63 Z"
      />
      <path
        fill="#d97706"
        d="m 4.962,20.521 28.357,29.03 v 13.367 l -6.901,-7.065 v -7.477 L 4.962,26.411 Z"
      />
      <path
        fill="#d97706"
        d="m 40.069,24.512 -0.381,0.39 -6.83,6.992 6.83,6.992 6.83,-6.992 -3.512,-3.596 2.44,-2.498 0.743,0.76 v -2.048 z"
      />
    </g>
  </svg>
);

const App: React.FC = () => {
  const { domains, activeDomain, loading, switchDomain, reload } = useDomains();
  const [isConnected, setIsConnected] = React.useState(true);

  // Listen for domain events via SSE to trigger reload
  useEffect(() => {
    const evtSource = new EventSource('/sse');

    evtSource.onopen = () => {
      setIsConnected(true);
    };

    evtSource.onerror = () => {
      setIsConnected(false);
    };

    evtSource.onmessage = (e) => {
      let payload: { event: string; data: any };
      try {
        payload = JSON.parse(e.data);
      } catch {
        return;
      }

      const { event } = payload;

      if (event === 'domain:created' || event === 'domain:deleted') {
        reload();
      }
    };

    return () => {
      evtSource.close();
    };
  }, [reload]);

  const handleSwitchDomain = async (domainId: string) => {
    const success = await switchDomain(domainId);
    if (!success) {
      alert('Failed to switch domain');
    }
  };

  return (
    <div className="app-layout">
      {/* Header */}
      <header className="header">
        <div
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: isConnected ? 'var(--success)' : 'var(--error)',
            flexShrink: 0,
          }}
          title={isConnected ? 'Connected' : 'Disconnected'}
        />
        <h1>
          <AtridesHawkIcon />
          <span>Majordomo</span>
        </h1>

        {!loading && (
          <DomainTabs
            domains={domains}
            activeDomain={activeDomain}
            onSwitch={handleSwitchDomain}
          />
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
            Domain: <strong style={{ color: 'var(--text)' }}>{activeDomain}</strong>
          </span>
        </div>
      </header>

      {/* Main Chat Pane */}
      <main style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {loading ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--text-dim)',
            }}
          >
            Loading...
          </div>
        ) : (
          <ChatPane activeDomain={activeDomain} />
        )}
      </main>

      {/* Sidebar - Placeholder for Phase 3 */}
      <aside
        style={{
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          minWidth: 0,
          padding: '24px',
          background: 'var(--surface)',
        }}
      >
        <div style={{ color: 'var(--text-dim)', fontSize: '13px', textAlign: 'center' }}>
          <h3 style={{ color: 'var(--accent)', marginBottom: '12px', fontSize: '13px' }}>
            Widgets
          </h3>
          <p>Placeholder sidebar</p>
          <p style={{ marginTop: '8px', fontSize: '11px' }}>Coming in Phase 3</p>
        </div>
      </aside>
    </div>
  );
};

// Mount React app
const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

const root = createRoot(rootElement);
root.render(<App />);
