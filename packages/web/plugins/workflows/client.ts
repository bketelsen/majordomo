/**
 * Workflow status widget plugin - client-side renderer
 * Vanilla JavaScript - NO framework dependencies
 */

import type { WidgetRenderer } from "../../src/types.ts";

interface WorkflowStep {
  id: string;
  stepId: string;
  agent: string;
  status: string;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  iterationIndex: number | null;
  iterationTotal: number | null;
}

interface WorkflowSummary {
  workflowId: string;
  workflowName: string;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  status: 'running' | 'done' | 'failed';
  createdAt: number;
  steps: WorkflowStep[];
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatAge(timestamp: number): string {
  const age = Math.round((Date.now() - timestamp) / 1000);
  if (age < 60) return `${age}s`;
  if (age < 3600) return `${Math.round(age / 60)}m`;
  if (age < 86400) return `${Math.round(age / 3600)}h`;
  return `${Math.round(age / 86400)}d`;
}

function renderStep(step: WorkflowStep): string {
  const icon = 
    step.status === 'done' ? '✅' :
    step.status === 'failed' ? '❌' :
    step.status === 'running' ? '⏳' :
    step.status === 'skipped' ? '⏭️' :
    '⏸️'; // pending
  
  const statusClass = `step-${step.status}`;
  const iteration = step.iterationIndex !== null 
    ? ` [${step.iterationIndex + 1}/${step.iterationTotal}]` 
    : '';
  
  const duration = step.startedAt && step.finishedAt
    ? `${((step.finishedAt - step.startedAt) / 1000).toFixed(1)}s`
    : step.startedAt
    ? `${((Date.now() - step.startedAt) / 1000).toFixed(0)}s`
    : '';
  
  const errorMsg = step.error 
    ? `<div class="step-error">${escapeHtml(step.error.slice(0, 100))}</div>`
    : '';
  
  return `
    <div class="workflow-step ${statusClass}">
      <span class="step-icon">${icon}</span>
      <span class="step-id">${escapeHtml(step.stepId)}${iteration}</span>
      <span class="step-agent">${escapeHtml(step.agent)}</span>
      ${duration ? `<span class="step-duration">${duration}</span>` : ''}
      ${errorMsg}
    </div>`;
}

function renderWorkflow(workflow: WorkflowSummary, autoExpand: boolean): string {
  const icon = 
    workflow.status === 'running' ? '⚙️' :
    workflow.status === 'failed' ? '⚠️' :
    '✅';
  
  const age = formatAge(workflow.createdAt);
  const progress = `${workflow.completedSteps}/${workflow.totalSteps}`;
  const statusClass = `workflow-${workflow.status}`;
  const expandedClass = autoExpand ? '' : 'collapsed';
  
  const steps = workflow.steps.map(s => renderStep(s)).join('');
  
  return `
    <div class="workflow-item ${statusClass} ${expandedClass}" data-workflow-id="${workflow.workflowId}">
      <div class="workflow-header" onclick="toggleWorkflow('${workflow.workflowId}')">
        <span class="workflow-icon">${icon}</span>
        <span class="workflow-name">${escapeHtml(workflow.workflowName)}</span>
        <span class="workflow-progress">${progress}</span>
        <span class="workflow-age">${age}</span>
        <span class="workflow-toggle">▼</span>
      </div>
      <div class="workflow-steps">
        ${steps}
      </div>
    </div>`;
}

export const renderer: WidgetRenderer = {
  render(data: unknown, config: Record<string, unknown>) {
    const { workflows } = data as { workflows: WorkflowSummary[] };
    const autoExpand = (config.autoExpand as boolean) ?? false;

    if (!workflows || workflows.length === 0) {
      return '<div class="empty">No workflows yet</div>';
    }

    return workflows.map(w => renderWorkflow(w, autoExpand)).join('');
  },

  mount(element: HTMLElement) {
    // Add toggle handler to window scope if not already present
    if (!(window as any).toggleWorkflow) {
      (window as any).toggleWorkflow = function(workflowId: string) {
        const workflow = element.querySelector(`[data-workflow-id="${workflowId}"]`);
        if (workflow) {
          workflow.classList.toggle('collapsed');
        }
      };
    }
    
    // Subscribe to SSE events for real-time updates
    if ((window as any).eventSource) {
      const es = (window as any).eventSource;
      
      const updateHandler = (event: MessageEvent) => {
        try {
          const { event: eventName, data: eventData } = JSON.parse(event.data);
          
          // Trigger widget refresh on workflow events
          if (eventName.startsWith('workflow:')) {
            console.log('[workflows] Received event:', eventName, eventData);
            // The main widget refresh mechanism will re-fetch data
            if ((window as any).refreshWidget) {
              (window as any).refreshWidget('workflows');
            }
          }
        } catch (err) {
          console.error('[workflows] Failed to handle SSE event:', err);
        }
      };
      
      es.addEventListener('message', updateHandler);
      
      // Store handler for cleanup
      (element as any).__sseHandler = updateHandler;
    }
  },

  unmount(element: HTMLElement) {
    // Clean up SSE listener
    if ((element as any).__sseHandler && (window as any).eventSource) {
      (window as any).eventSource.removeEventListener('message', (element as any).__sseHandler);
      delete (element as any).__sseHandler;
    }
  },

  styles: `
    .workflow-item { 
      border-bottom: 1px solid var(--border); 
      margin-bottom: 8px; 
    }
    .workflow-item:last-child { border-bottom: none; margin-bottom: 0; }
    
    .workflow-header { 
      display: flex; 
      align-items: center; 
      gap: 8px; 
      padding: 6px 0; 
      cursor: pointer; 
      user-select: none;
      font-size: 12px;
    }
    .workflow-header:hover { opacity: 0.8; }
    
    .workflow-icon { font-size: 14px; }
    .workflow-name { 
      font-weight: 600; 
      flex: 1; 
      color: var(--accent);
    }
    .workflow-progress { 
      font-size: 11px; 
      color: var(--text-dim); 
      font-family: monospace;
    }
    .workflow-age { 
      font-size: 11px; 
      color: var(--text-dim); 
    }
    .workflow-toggle { 
      font-size: 10px; 
      color: var(--text-dim); 
      transition: transform 0.2s;
    }
    .workflow-item.collapsed .workflow-toggle { transform: rotate(-90deg); }
    .workflow-item.collapsed .workflow-steps { display: none; }
    
    .workflow-steps { 
      padding: 8px 0 8px 20px; 
      display: flex; 
      flex-direction: column; 
      gap: 4px;
    }
    
    .workflow-step { 
      display: flex; 
      align-items: center; 
      gap: 6px; 
      font-size: 11px;
      padding: 4px 0;
    }
    
    .step-icon { font-size: 12px; }
    .step-id { 
      font-weight: 500; 
      min-width: 100px;
      color: var(--text);
    }
    .step-agent { 
      color: var(--text-dim); 
      font-size: 10px;
    }
    .step-duration { 
      margin-left: auto; 
      font-family: monospace; 
      font-size: 10px;
      color: var(--text-dim);
    }
    
    .step-error { 
      margin-top: 4px; 
      padding: 4px 8px; 
      background: var(--error-bg, #3a1a1a); 
      color: var(--error, #ff6b6b); 
      font-size: 10px; 
      border-radius: 3px;
      font-family: monospace;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    
    .workflow-running .workflow-name { color: var(--accent); }
    .workflow-failed .workflow-name { color: var(--error, #ff6b6b); }
    .workflow-done .workflow-name { color: var(--text-dim); }
    
    .step-done { opacity: 0.7; }
    .step-failed { color: var(--error, #ff6b6b); }
    .step-running .step-icon { animation: spin 2s linear infinite; }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `,
};
