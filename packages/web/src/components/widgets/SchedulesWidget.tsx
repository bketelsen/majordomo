/**
 * SchedulesWidget - Shows scheduled jobs
 */

import React from 'react';
import { useWidget } from '../../hooks/useWidget';
import { Widget } from './Widget';

interface ScheduleJob {
  id: string;
  cron: string;
  action: string;
  enabled: boolean;
  lastRan?: number;
}

interface SchedulesData {
  jobs: ScheduleJob[];
}

const escapeHtml = (text: string) => {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
};

export const SchedulesWidget: React.FC = () => {
  const { data, loading, refresh } = useWidget<SchedulesData>('schedules', 30000);

  const handleTrigger = async (jobId: string) => {
    try {
      const res = await fetch(`/api/schedules/${jobId}/trigger`, { method: 'POST' });
      if (res.ok) {
        const d = await res.json();
        if (d.triggered) {
          alert(`Job '${jobId}' triggered — check chat for response`);
        }
      } else {
        alert('Failed to trigger job');
      }
    } catch (err) {
      alert('Failed to trigger job');
    }
  };

  const jobs = data?.jobs ?? [];

  return (
    <Widget id="widget-schedules" title="Schedules" icon="⏰" refreshable onRefresh={refresh}>
      {loading ? (
        <div className="empty">Loading…</div>
      ) : jobs.length === 0 ? (
        <div className="empty">No schedules</div>
      ) : (
        jobs.map((j) => {
          const lastRan = j.lastRan
            ? new Date(j.lastRan).toLocaleDateString([], { month: 'short', day: 'numeric' })
            : 'never';
          return (
            <div
              key={j.id}
              className="schedule-item"
              style={j.enabled ? {} : { opacity: 0.4 }}
            >
              <span className="schedule-id" title={j.action}>
                {escapeHtml(j.id)}
              </span>
              <span className="schedule-cron">{escapeHtml(j.cron)}</span>
              <span className="schedule-last">{lastRan}</span>
              <button
                className="action-btn"
                title="Trigger now"
                onClick={() => handleTrigger(j.id)}
              >
                ▶
              </button>
            </div>
          );
        })
      )}
    </Widget>
  );
};
