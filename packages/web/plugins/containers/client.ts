/**
 * Containers widget plugin - client-side renderer
 */

import type { WidgetRenderer } from "../../src/types.ts";

interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  running: boolean;
  ports: string[];
  runtime: "docker" | "incus";
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
    const { containers } = data as { containers: ContainerInfo[] };

    if (!containers || containers.length === 0) {
      return '<div class="empty">No containers found</div>';
    }

    return containers.map(c => {
      const dot = c.running 
        ? '<span class="status-dot-run"></span>' 
        : '<span class="status-dot-stop"></span>';
      const badge = `<span class="container-badge">${c.runtime}</span>`;
      const ports = c.ports.length 
        ? `<div class="container-ports">${c.ports.slice(0, 3).map(escapeHtml).join(' · ')}</div>` 
        : '';
      const actionBtn = c.running
        ? `<button class="action-btn danger" data-runtime="${c.runtime}" data-id="${escapeHtml(c.id)}" data-action="stop">Stop</button>`
        : `<button class="action-btn" data-runtime="${c.runtime}" data-id="${escapeHtml(c.id)}" data-action="start">Start</button>`;

      return `
        <div class="container-item">
          <div class="container-row">
            ${dot}
            <span class="container-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
            ${badge}
            ${actionBtn}
          </div>
          <div class="container-image">${escapeHtml(c.image)} · ${escapeHtml(c.status)}</div>
          ${ports}
        </div>
      `;
    }).join('');
  },

  mount(element, data) {
    // Attach click handlers to action buttons
    const buttons = element.querySelectorAll('.action-btn');
    buttons.forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const target = e.target as HTMLButtonElement;
        const runtime = target.dataset.runtime;
        const id = target.dataset.id;
        const action = target.dataset.action;

        if (!runtime || !id || !action) return;

        target.disabled = true;
        target.textContent = '...';

        try {
          const res = await fetch(`/api/widgets/containers/action/${runtime}/${id}/${action}`, {
            method: 'POST',
          });
          const result = await res.json();

          if (result.ok) {
            // Refresh widget after action
            setTimeout(() => {
              // Trigger refresh via global function
              if (typeof (window as any).loadWidget === 'function') {
                (window as any).loadWidget('containers');
              }
            }, 1500);
          } else {
            alert('Action failed');
            target.disabled = false;
            target.textContent = action.charAt(0).toUpperCase() + action.slice(1);
          }
        } catch (err) {
          console.error('Container action failed:', err);
          alert('Network error');
          target.disabled = false;
          target.textContent = action.charAt(0).toUpperCase() + action.slice(1);
        }
      });
    });
  },

  unmount(element) {
    // Event listeners will be cleaned up when element is removed
  },

  styles: `
    /* Additional container-specific styles (if needed beyond base styles) */
  `,
};
