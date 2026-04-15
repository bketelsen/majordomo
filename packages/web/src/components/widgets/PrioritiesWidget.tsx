/**
 * PrioritiesWidget - Shows active high-priority items
 */

import React from 'react';
import { useWidget } from '../../hooks/useWidget';
import { Widget } from './Widget';

interface PriorityItem {
  priority: string;
  task: string;
  domain: string;
  due?: string;
}

interface PrioritiesData {
  items: PriorityItem[];
  updatedAt?: string;
}

const escapeHtml = (text: string) => {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

export const PrioritiesWidget: React.FC = () => {
  const { data, loading, refresh, updatedAt } = useWidget<PrioritiesData>('priorities', 60000);

  const handleMarkDone = async (domain: string, task: string) => {
    try {
      const res = await fetch('/api/priorities/done', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, task }),
      });
      if (res.ok) {
        refresh();
      } else {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        alert('Could not mark done: ' + (err?.error ?? 'unknown error'));
      }
    } catch (err) {
      alert('Could not mark done: network error');
    }
  };

  const items = data?.items ?? [];

  return (
    <Widget
      id="widget-priorities"
      title="Active Priorities"
      icon="🔥"
      refreshable
      onRefresh={refresh}
      updatedAt={updatedAt}
    >
      {loading ? (
        <div className="empty">Loading…</div>
      ) : items.length === 0 ? (
        <div className="empty">No high-priority items 🎉</div>
      ) : (
        items.map((item, idx) => (
          <div key={idx} className="priority-item">
            <span className={`pri-badge pri-${item.priority}`}>{item.priority}</span>
            <div style={{ flex: 1 }}>
              <div>{escapeHtml(item.task)}</div>
              <div className="pri-domain">{item.domain}</div>
            </div>
            {item.due && <span className="pri-due">{item.due}</span>}
            <button
              className="action-btn"
              onClick={() => handleMarkDone(item.domain, item.task)}
              title="Mark done"
            >
              ✓
            </button>
          </div>
        ))
      )}
    </Widget>
  );
};
