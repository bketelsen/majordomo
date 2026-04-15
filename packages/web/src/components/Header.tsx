/**
 * Header - Top navigation bar with status, logo, domain tabs, and controls
 */

import React, { useState } from 'react';
import { DomainTabs } from './DomainTabs';
import { Domain } from '../hooks/useDomains';
import { NewDomainModal } from './NewDomainModal';

interface HeaderProps {
  isConnected: boolean;
  domains: Domain[];
  activeDomain: string;
  onSwitchDomain: (domainId: string) => void;
  onToggleSidebar?: () => void;
  onToggleTerminal?: () => void;
}

// Atreides Hawk SVG
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

export const Header: React.FC<HeaderProps> = ({
  isConnected,
  domains,
  activeDomain,
  onSwitchDomain,
  onToggleSidebar,
  onToggleTerminal,
}) => {
  const [showNewDomainModal, setShowNewDomainModal] = useState(false);

  return (
    <>
      <header id="header">
        {onToggleSidebar && (
          <button id="sidebar-toggle" onClick={onToggleSidebar} title="Toggle sidebar">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="7" height="18" rx="1" />
              <rect x="14" y="3" width="7" height="18" rx="1" />
            </svg>
          </button>
        )}

        <span
          id="status-dot"
          className={isConnected ? '' : 'offline'}
          title={isConnected ? 'Connected' : 'Disconnected'}
        />

        <h1>
          <AtridesHawkIcon />
          <span>Majordomo</span>
        </h1>

        <DomainTabs domains={domains} activeDomain={activeDomain} onSwitch={onSwitchDomain} />

        <button
          className="tab-add"
          title="New domain"
          onClick={() => setShowNewDomainModal(true)}
        >
          +
        </button>

        {onToggleTerminal && (
          <button className="terminal-btn" title="Open terminal (`)" onClick={onToggleTerminal}>
            <span>❯_</span>
          </button>
        )}

        <div id="header-right">
          <span>
            Domain: <strong id="active-domain-badge">{activeDomain}</strong>
          </span>
          <span id="model-label">···</span>
        </div>
      </header>

      {showNewDomainModal && (
        <NewDomainModal onClose={() => setShowNewDomainModal(false)} activeDomain={activeDomain} />
      )}
    </>
  );
};
