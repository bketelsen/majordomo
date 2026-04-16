/**
 * WorkflowsWidget - Shows workflow execution status with step details
 */

import React, { useState, useEffect } from 'react';
import { useWidget } from '../../hooks/useWidget';
import { Widget } from './Widget';

interface WorkflowStep {
  id: string;
  stepId: string;
  agent: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  startedAt: number | null;
  finishedAt: number | null;
  iterationIndex: number | null;
  iterationTotal: number | null;
  error: string | null;
}

interface Workflow {
  workflowId: string;
  workflowName: string;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  status: 'running' | 'done' | 'failed';
  createdAt: number;
  steps: WorkflowStep[];
}

interface WorkflowData {
  workflows: Workflow[];
}

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function stepIcon(status: WorkflowStep['status']): string {
  switch (status) {
    case 'done': return '✅';
    case 'failed': return '❌';
    case 'running': return '⏳';
    case 'skipped': return '⏭️';
    default: return '⏸️';
  }
}

const WorkflowCard: React.FC<{ wf: Workflow }> = ({ wf }) => {
  const [expanded, setExpanded] = useState(wf.status === 'running');
  const age = elapsed(Date.now() - wf.createdAt);
  const statusColor = wf.status === 'done' ? 'var(--success)' : wf.status === 'failed' ? 'var(--error)' : 'var(--warning)';
  const statusIcon = wf.status === 'done' ? '✅' : wf.status === 'failed' ? '❌' : '⏳';

  return (
    <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: '8px', marginBottom: '8px' }}>
      <div
        onClick={() => setExpanded(e => !e)}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
      >
        <span>{statusIcon}</span>
        <span style={{ flex: 1, fontSize: '12px', fontFamily: 'var(--font)', fontWeight: 600, color: 'var(--text)' }}>
          {wf.workflowName}
        </span>
        <span style={{ fontSize: '10px', color: statusColor }}>{wf.status}</span>
        <span style={{ fontSize: '10px', color: 'var(--text-dim)' }}>{age}</span>
        <span style={{ fontSize: '9px', color: 'var(--text-dim)', transform: expanded ? 'none' : 'rotate(-90deg)', display: 'inline-block' }}>▾</span>
      </div>

      {/* Progress bar */}
      <div style={{ height: '3px', background: 'var(--surface2)', borderRadius: '2px', margin: '4px 0' }}>
        <div style={{
          height: '100%',
          width: `${wf.totalSteps > 0 ? (wf.completedSteps / wf.totalSteps) * 100 : 0}%`,
          background: wf.status === 'failed' ? 'var(--error)' : 'var(--accent)',
          borderRadius: '2px',
          transition: 'width 0.3s ease'
        }} />
      </div>
      <div style={{ fontSize: '10px', color: 'var(--text-dim)' }}>
        {wf.completedSteps}/{wf.totalSteps} steps
      </div>

      {/* Step details */}
      {expanded && wf.steps.length > 0 && (
        <div style={{ marginTop: '6px', paddingLeft: '8px', borderLeft: '2px solid var(--border)' }}>
          {wf.steps.map(step => (
            <div key={step.id} style={{ fontSize: '11px', color: 'var(--text-dim)', padding: '2px 0', display: 'flex', gap: '6px', alignItems: 'center' }}>
              <span>{stepIcon(step.status)}</span>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>{step.agent}</span>
              <span style={{ color: 'var(--text-dim)' }}>({step.stepId})</span>
              {step.iterationIndex !== null && (
                <span style={{ color: 'var(--text-dim)' }}>{step.iterationIndex + 1}/{step.iterationTotal}</span>
              )}
              {step.startedAt && step.finishedAt && (
                <span style={{ marginLeft: 'auto' }}>{elapsed(step.finishedAt - step.startedAt)}</span>
              )}
              {step.status === 'running' && step.startedAt && (
                <span style={{ marginLeft: 'auto', color: 'var(--warning)' }}>{elapsed(Date.now() - step.startedAt)}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {wf.status === 'failed' && wf.steps.find(s => s.error) && (
        <div style={{ fontSize: '10px', color: 'var(--error)', marginTop: '4px' }}>
          {wf.steps.find(s => s.error)?.error?.slice(0, 100)}
        </div>
      )}
    </div>
  );
};

export const WorkflowsWidget: React.FC = () => {
  const { data, loading, refresh, updatedAt } = useWidget<WorkflowData>('workflows', 10000);

  // Listen for workflow SSE events to trigger refresh
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      let payload: { event: string };
      try { payload = JSON.parse(e.data); } catch { return; }
      if (payload.event?.startsWith('workflow:')) refresh();
    };

    // Reuse the existing SSE connection via window event (avoids duplicate connections)
    window.addEventListener('sse:message' as any, handler);

    return () => window.removeEventListener('sse:message' as any, handler);
  }, [refresh]);

  const workflows = (data?.workflows ?? []).slice(0, 8);

  return (
    <Widget
      id="widget-workflows"
      title="Workflow Status"
      icon="🔄"
      refreshable
      onRefresh={refresh}
      updatedAt={updatedAt}
    >
      {loading ? (
        <div className="empty">Loading…</div>
      ) : workflows.length === 0 ? (
        <div className="empty">No workflows yet</div>
      ) : (
        workflows.map(wf => <WorkflowCard key={wf.workflowId} wf={wf} />)
      )}
    </Widget>
  );
};
