/**
 * SubagentsWidget - Shows recent subagent runs
 */

import React from 'react';
import { useWidget } from '../../hooks/useWidget';
import { Widget } from './Widget';

interface SubagentRun {
  agent: string;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  outputPreview?: string;
  error?: string;
}

interface SubagentsData {
  runs: SubagentRun[];
  updatedAt?: string;
}

const escapeHtml = (text: string) => {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
};

export const SubagentsWidget: React.FC = () => {
  const { data, loading, refresh, updatedAt } = useWidget<SubagentsData>('subagents', 10000);

  const runs = (data?.runs ?? []).slice(0, 8);

  return (
    <Widget
      id="widget-subagents"
      title="Subagent Runs"
      icon="⚙"
      refreshable
      onRefresh={refresh}
      updatedAt={updatedAt}
    >
      {loading ? (
        <div className="empty">Loading…</div>
      ) : runs.length === 0 ? (
        <div className="empty">No runs yet</div>
      ) : (
        runs.map((r, idx) => {
          const icon = r.status === 'done' ? '✅' : r.status === 'failed' ? '❌' : '⏳';
          const age = Math.round((Date.now() - r.startedAt) / 1000);
          const ageStr =
            age < 60 ? `${age}s` : age < 3600 ? `${Math.round(age / 60)}m` : `${Math.round(age / 3600)}h`;

          return (
            <div key={idx} className="run-item">
              <div className="run-header">
                {icon} <span className="run-agent">{escapeHtml(r.agent)}</span>
                <span className={`run-badge run-${r.status}`}>{r.status}</span>
                <span className="run-time">{ageStr} ago</span>
              </div>
              {r.outputPreview && (
                <div className="run-preview">{escapeHtml(r.outputPreview.slice(0, 80))}</div>
              )}
              {r.error && (
                <div className="run-preview" style={{ color: 'var(--error)' }}>
                  {escapeHtml(r.error.slice(0, 80))}
                </div>
              )}
            </div>
          );
        })
      )}
    </Widget>
  );
};
