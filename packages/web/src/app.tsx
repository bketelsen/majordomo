/**
 * Majordomo React App Entry Point
 * Phase 1: Minimal shell that proves the React pipeline works
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';

// Atreides Hawk SVG (inline from current UI)
const AtridesHawkIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="24" height="24" fill="currentColor">
    <path d="M32 8 L28 12 L24 16 L20 20 L16 24 L12 28 L10 32 L12 36 L16 40 L20 44 L24 48 L28 52 L32 56 L36 52 L40 48 L44 44 L48 40 L52 36 L54 32 L52 28 L48 24 L44 20 L40 16 L36 12 Z M32 16 L36 20 L40 24 L44 28 L46 32 L44 36 L40 40 L36 44 L32 48 L28 44 L24 40 L20 36 L18 32 L20 28 L24 24 L28 20 Z M32 24 C28 24 24 28 24 32 C24 36 28 40 32 40 C36 40 40 36 40 32 C40 28 36 24 32 24 Z" />
  </svg>
);

const App: React.FC = () => {
  return (
    <div className="app-layout">
      {/* Header */}
      <header className="header">
        <h1>
          <AtridesHawkIcon />
          Majordomo
        </h1>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' }}>
          <div 
            style={{ 
              width: '8px', 
              height: '8px', 
              borderRadius: '50%', 
              background: 'var(--success)' 
            }}
            title="Connected"
          />
        </div>
      </header>

      {/* Main Chat Pane */}
      <main className="chat-pane">
        <div className="placeholder">
          <h2 style={{ color: 'var(--accent)', marginBottom: '16px' }}>
            React Migration - Phase 1
          </h2>
          <p style={{ marginBottom: '8px' }}>
            ✓ React pipeline working
          </p>
          <p style={{ marginBottom: '8px' }}>
            ✓ Dune CSS variables imported
          </p>
          <p style={{ marginBottom: '8px' }}>
            ✓ Layout grid rendered
          </p>
          <p style={{ marginBottom: '8px' }}>
            ✓ Atreides hawk SVG inline
          </p>
          <p style={{ marginTop: '24px', color: 'var(--text-dim)' }}>
            Next: Phase 2 will add functional chat components
          </p>
        </div>
      </main>

      {/* Sidebar */}
      <aside className="sidebar">
        <div className="placeholder">
          <h3 style={{ color: 'var(--accent)', marginBottom: '12px', fontSize: '13px' }}>
            Widgets
          </h3>
          <p>Placeholder sidebar</p>
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
