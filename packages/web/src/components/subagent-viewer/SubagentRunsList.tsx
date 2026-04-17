/**
 * SubagentRunsList - List of recent subagent runs
 */

import React from 'react';

export interface SubagentRun {
  id: string;
  agent: string;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  finishedAt: number | null;
}

interface SubagentRunsListProps {
  runs: SubagentRun[];
  onSelectRun: (runId: string, isLive: boolean) => void;
}

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function relativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export const SubagentRunsList: React.FC<SubagentRunsListProps> = ({ runs, onSelectRun }) => {
  if (runs.length === 0) {
    return <div className="empty" style={{ padding: '12px', color: 'var(--text-dim)' }}>No runs yet</div>;
  }

  return (
    <div className="subagent-runs-list">
      {runs.map((run) => {
        const isLive = run.status === 'running';
        const duration = run.finishedAt 
          ? elapsed(run.finishedAt - run.startedAt)
          : elapsed(Date.now() - run.startedAt);
        const age = relativeTime(run.startedAt);
        
        let statusIcon = '✅';
        let statusColor = 'var(--success)';
        
        if (run.status === 'running') {
          statusIcon = '⏳';
          statusColor = 'var(--warning)';
        } else if (run.status === 'failed') {
          statusIcon = '❌';
          statusColor = 'var(--error)';
        }

        return (
          <div
            key={run.id}
            className="run-item"
            onClick={() => onSelectRun(run.id, isLive)}
            style={{
              cursor: 'pointer',
              padding: '8px 12px',
              borderBottom: '1px solid var(--border)',
              transition: 'background 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--surface2)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <span style={{ fontSize: '14px' }}>{statusIcon}</span>
              <span style={{ 
                flex: 1, 
                fontSize: '13px', 
                fontFamily: 'var(--font-mono)',
                color: 'var(--accent)',
                fontWeight: 600
              }}>
                {run.agent}
              </span>
              <span style={{ 
                fontSize: '10px', 
                padding: '2px 6px',
                borderRadius: '4px',
                background: statusColor,
                color: 'var(--bg-primary)',
                textTransform: 'uppercase',
                fontWeight: 600
              }}>
                {run.status}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '11px', color: 'var(--text-dim)' }}>
              <span>⏱️ {duration}</span>
              <span>•</span>
              <span>{age}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
};
