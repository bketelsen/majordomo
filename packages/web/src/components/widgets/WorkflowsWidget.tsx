/**
 * WorkflowsWidget - Shows workflow status
 */

import React, { useEffect } from 'react';
import { useWidget } from '../../hooks/useWidget';
import { Widget } from './Widget';

interface WorkflowData {
  workflows: any[];
}

export const WorkflowsWidget: React.FC = () => {
  const { data, loading, refresh, updatedAt } = useWidget<WorkflowData>('workflows', 10000);

  // Listen for workflow SSE events to trigger refresh
  useEffect(() => {
    const evtSource = new EventSource('/sse');

    evtSource.onmessage = (e) => {
      let payload: { event: string; data: any };
      try {
        payload = JSON.parse(e.data);
      } catch {
        return;
      }

      const { event } = payload;

      // Refresh on any workflow event
      if (
        event === 'workflow:started' ||
        event === 'workflow:step_start' ||
        event === 'workflow:step_complete' ||
        event === 'workflow:step_failed' ||
        event === 'workflow:complete'
      ) {
        refresh();
      }
    };

    return () => {
      evtSource.close();
    };
  }, [refresh]);

  const workflows = data?.workflows ?? [];

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
        <div style={{ fontSize: '13px', color: 'var(--text-dim)' }}>
          {workflows.length} workflow(s) active
        </div>
      )}
    </Widget>
  );
};
