/**
 * DomainTabs - Tab bar for switching between domains
 */

import React from 'react';
import { Domain } from '../hooks/useDomains';

interface DomainTabsProps {
  domains: Domain[];
  activeDomain: string;
  onSwitch: (domainId: string) => void;
  onNewDomain?: () => void;
}

export const DomainTabs: React.FC<DomainTabsProps> = ({
  domains,
  activeDomain,
  onSwitch,
  onNewDomain,
}) => {
  return (
    <div
      style={{
        display: 'flex',
        gap: '2px',
        overflowX: 'auto',
        flex: '1 1 auto',
        minWidth: 0,
        scrollbarWidth: 'none',
      }}
    >
      {domains.map((domain) => (
        <div
          key={domain.id}
          className={`tab ${domain.id === activeDomain ? 'active' : ''}`}
          onClick={() => onSwitch(domain.id)}
          title={domain.label}
          style={{
            padding: '6px 14px',
            borderRadius: 'var(--radius)',
            cursor: 'pointer',
            fontSize: '12px',
            color: domain.id === activeDomain ? 'var(--text)' : 'var(--text-dim)',
            whiteSpace: 'nowrap',
            transition: 'all 0.15s',
            border: '1px solid transparent',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            fontFamily: 'var(--font)',
            touchAction: 'manipulation',
            minHeight: '44px',
            display: 'flex',
            alignItems: 'center',
            background: domain.id === activeDomain ? 'var(--accent-dim)' : 'transparent',
            borderColor: domain.id === activeDomain ? 'var(--accent)' : 'transparent',
          }}
          onMouseEnter={(e) => {
            if (domain.id !== activeDomain) {
              e.currentTarget.style.background = 'var(--surface2)';
              e.currentTarget.style.color = 'var(--text)';
            }
          }}
          onMouseLeave={(e) => {
            if (domain.id !== activeDomain) {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--text-dim)';
            }
          }}
        >
          {domain.id}
        </div>
      ))}
      {onNewDomain && (
        <div
          className="tab-add"
          onClick={onNewDomain}
          title="New domain"
          style={{
            padding: '6px 10px',
            color: 'var(--text-dim)',
            fontSize: '18px',
            cursor: 'pointer',
            borderRadius: 'var(--radius)',
            minHeight: '44px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--accent)';
            e.currentTarget.style.background = 'var(--surface2)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--text-dim)';
            e.currentTarget.style.background = 'transparent';
          }}
        >
          +
        </div>
      )}
    </div>
  );
};
