/**
 * Subagents widget plugin - client-side renderer
 */

import type { WidgetRenderer } from "../../src/types.ts";

interface SubagentRun {
  id: string;
  agent: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  retries: number;
  outputPreview: string | null;
  error: string | null;
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
    const { runs } = data as { runs: SubagentRun[] };

    if (!runs || runs.length === 0) {
      return '<div class="empty">No runs yet</div>';
    }

    // Display first 8 runs
    const displayRuns = runs.slice(0, 8);

    return displayRuns.map(r => {
      const icon = r.status === 'done' ? '✅' : r.status === 'failed' ? '❌' : '⏳';
      const age = Math.round((Date.now() - r.startedAt) / 1000);
      const ageStr = age < 60 ? `${age}s` : age < 3600 ? `${Math.round(age/60)}m` : `${Math.round(age/3600)}h`;
      const preview = r.outputPreview 
        ? `<div class="run-preview">${escapeHtml(r.outputPreview.slice(0, 80))}</div>` 
        : '';
      const errPreview = r.error 
        ? `<div class="run-preview" style="color:var(--error)">${escapeHtml(r.error.slice(0, 80))}</div>` 
        : '';
      
      return `
        <div class="run-item">
          <div class="run-header">
            ${icon} <span class="run-agent">${escapeHtml(r.agent)}</span>
            <span class="run-badge run-${r.status}">${r.status}</span>
            <span class="run-time">${ageStr} ago</span>
          </div>
          ${preview}${errPreview}
        </div>`;
    }).join('');
  },

  unmount(element) {
    // No cleanup needed
  },

  styles: `
    /* Subagent-specific styles (inherits base widget styles) */
  `,
};
