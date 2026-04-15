/**
 * Schedules widget plugin - client-side renderer
 */

import type { WidgetRenderer } from "../../src/types.ts";

interface ScheduledJob {
  id: string;
  cron: string;
  action: string;
  enabled: boolean;
  lastRan: number | null;
  runCount: number;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const renderer: WidgetRenderer = {
  render(data: unknown) {
    const { jobs } = data as { jobs: ScheduledJob[] };

    if (!jobs || jobs.length === 0) {
      return '<div class="empty">No schedules</div>';
    }

    return jobs.map(j => {
      const lastRan = j.lastRan 
        ? new Date(j.lastRan).toLocaleDateString([], { month: 'short', day: 'numeric' }) 
        : 'never';
      const triggerBtn = `<button class="action-btn" title="Trigger now" data-job-id="${escapeHtml(j.id)}">▶</button>`;
      const disabled = j.enabled ? '' : ' style="opacity:0.4"';
      
      return `
        <div class="schedule-item"${disabled}>
          <span class="schedule-id" title="${escapeHtml(j.action)}">${escapeHtml(j.id)}</span>
          <span class="schedule-cron">${escapeHtml(j.cron)}</span>
          <span class="schedule-last">${lastRan}</span>
          ${triggerBtn}
        </div>`;
    }).join('');
  },

  mount(element, data) {
    // Attach click handlers to trigger buttons
    const buttons = element.querySelectorAll('.action-btn');
    buttons.forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const target = e.target as HTMLButtonElement;
        const jobId = target.dataset.jobId;
        
        if (!jobId) return;
        
        target.disabled = true;
        const originalText = target.textContent;
        target.textContent = '...';
        
        try {
          const res = await fetch(`/api/schedules/${jobId}/trigger`, {
            method: 'POST',
          });
          
          if (res.ok) {
            const result = await res.json();
            if (result.triggered) {
              alert(`Job '${jobId}' triggered — check chat for response`);
            }
          } else {
            alert('Failed to trigger job');
          }
        } catch (err) {
          console.error('Schedule trigger failed:', err);
          alert('Network error');
        } finally {
          target.disabled = false;
          target.textContent = originalText;
        }
      });
    });
  },

  unmount(element) {
    // Event listeners will be cleaned up when element is removed
  },

  styles: `
    /* Schedule-specific styles (inherits base widget styles) */
  `,
};
