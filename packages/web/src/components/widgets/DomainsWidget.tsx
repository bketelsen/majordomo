/**
 * DomainsWidget - Shows active domains with click to switch
 */

import React from 'react';
import { Widget } from './Widget';
import { Domain } from '../../hooks/useDomains';

interface DomainsWidgetProps {
  domains: Domain[];
  activeDomain: string;
  onSwitch: (domainId: string) => void;
}

const escapeHtml = (text: string) => {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
};

export const DomainsWidget: React.FC<DomainsWidgetProps> = ({
  domains,
  activeDomain,
  onSwitch,
}) => {
  return (
    <Widget id="widget-domains" title="Domains" icon="📂">
      {domains.length === 0 ? (
        <div className="empty">No domains</div>
      ) : (
        domains.map((d) => (
          <div
            key={d.id}
            style={{
              padding: '4px 0',
              cursor: 'pointer',
              color: d.id === activeDomain ? 'var(--accent)' : 'var(--text)',
            }}
            onClick={() => onSwitch(d.id)}
          >
            {d.id}{' '}
            <span style={{ color: 'var(--text-dim)', fontSize: '12px' }}>
              — {escapeHtml(d.label)}
            </span>
          </div>
        ))
      )}
    </Widget>
  );
};
