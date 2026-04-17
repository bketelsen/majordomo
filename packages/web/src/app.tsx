/**
 * Majordomo React App Entry Point
 * Phase 3: Complete React UI with widgets, terminal, and full production-ready features
 */

import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { useDomains } from './hooks/useDomains';
import { ChatPane } from './components/ChatPane';
import { Header } from './components/Header';
import { WidgetPanel } from './components/widgets/WidgetPanel';
import { QuakeTerminal } from './components/QuakeTerminal';

const App: React.FC = () => {
  const { domains, activeDomain, loading, switchDomain, reload } = useDomains();
  const [isConnected, setIsConnected] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleDomainEvent = useCallback((event: string) => {
    if (event === 'domain:created' || event === 'domain:deleted') {
      reload();
    }
  }, [reload]);

  const handleConnectionChange = useCallback((connected: boolean) => {
    setIsConnected(connected);
  }, []);

  const handleSwitchDomain = async (domainId: string) => {
    const success = await switchDomain(domainId);
    if (!success) {
      alert('Failed to switch domain');
    }
    // Close sidebar on mobile after switching
    setSidebarOpen(false);
  };

  // Close sidebar when clicking outside on mobile
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (!sidebarOpen) return;
      const target = e.target as HTMLElement;
      const panel = document.getElementById('widget-panel');
      const toggle = document.getElementById('sidebar-toggle');
      if (panel && toggle && !panel.contains(target) && !toggle.contains(target)) {
        setSidebarOpen(false);
      }
    };

    if (window.matchMedia('(max-width: 768px)').matches) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [sidebarOpen]);

  // Apply sidebar-open class to body
  useEffect(() => {
    if (sidebarOpen) {
      document.body.classList.add('sidebar-open');
    } else {
      document.body.classList.remove('sidebar-open');
    }
  }, [sidebarOpen]);

  return (
    <>
      <QuakeTerminal />
      <div id="app">
        <Header
          isConnected={isConnected}
          domains={domains}
          activeDomain={activeDomain}
          onSwitchDomain={handleSwitchDomain}
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        />

        {/* Main Chat Pane */}
        <main id="chat-pane">
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
            <ChatPane
              activeDomain={activeDomain}
              onDomainEvent={handleDomainEvent}
              onConnectionChange={handleConnectionChange}
            />
          )}
        </main>

        {/* Widget Panel */}
        <WidgetPanel
          domains={domains}
          activeDomain={activeDomain}
          onSwitchDomain={handleSwitchDomain}
        />
      </div>
    </>
  );
};

// Mount React app
const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

const root = createRoot(rootElement);
root.render(<App />);

// PWA Service Worker registration
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    console.log('Service worker registration failed');
  });
}
