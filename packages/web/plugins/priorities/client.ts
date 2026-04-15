/**
 * Priorities widget plugin - client-side renderer
 */

import type { WidgetRenderer } from "../../src/types.ts";

interface PriorityItem {
  domain: string;
  task: string;
  priority: string;
  due?: string;
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
    const { items } = data as { items: PriorityItem[] };

    if (!items || items.length === 0) {
      return '<div class="empty">No high-priority items 🎉</div>';
    }

    return items.map(item => {
      // Escape single quotes for inline onclick handler
      const escapedTask = escapeHtml(item.task).replace(/'/g, "&#39;");
      const escapedDomain = escapeHtml(item.domain);
      
      return `
        <div class="priority-item">
          <span class="pri-badge pri-${item.priority}">${item.priority}</span>
          <div style="flex:1">
            <div>${escapeHtml(item.task)}</div>
            <div class="pri-domain">${escapedDomain}</div>
          </div>
          ${item.due ? `<span class="pri-due">${item.due}</span>` : ''}
          <button class="action-btn mark-done-btn" data-domain="${escapedDomain}" data-task="${escapeHtml(item.task)}" title="Mark done">✓</button>
        </div>
      `;
    }).join('');
  },

  mount(element, data) {
    // Attach click handlers to mark-done buttons
    const buttons = element.querySelectorAll('.mark-done-btn');
    buttons.forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const target = e.target as HTMLButtonElement;
        const domain = target.dataset.domain;
        const task = target.dataset.task;

        if (!domain || !task) return;

        target.disabled = true;
        const originalText = target.textContent;
        target.textContent = '...';

        try {
          const res = await fetch('/api/widgets/priorities/done', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain, task }),
          });

          if (res.ok) {
            // Refresh widget after marking done
            setTimeout(() => {
              if (typeof (window as any).loadWidget === 'function') {
                (window as any).loadWidget('priorities');
              }
            }, 500);
          } else {
            const err = await res.json().catch(() => ({}));
            alert('Could not mark done: ' + (err?.error ?? 'unknown error'));
            target.disabled = false;
            target.textContent = originalText ?? '✓';
          }
        } catch (err) {
          console.error('Mark priority done failed:', err);
          alert('Network error');
          target.disabled = false;
          target.textContent = originalText ?? '✓';
        }
      });
    });
  },

  unmount(element) {
    // Event listeners will be cleaned up when element is removed
  },

  styles: `
    /* Additional priority-specific styles (if needed beyond base styles) */
  `,
};
