/**
 * SubagentViewer - Main component combining runs list and session viewer drawer
 */

import React, { useState, useEffect } from 'react';
import { SubagentRunsList, SubagentRun } from './SubagentRunsList';
import { SessionViewerDrawer } from './SessionViewerDrawer';

export const SubagentViewer: React.FC = () => {
  const [runs, setRuns] = useState<SubagentRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRun, setSelectedRun] = useState<{ id: string; isLive: boolean } | null>(null);

  const fetchRuns = async () => {
    try {
      const response = await fetch('/api/subagents');
      const data = await response.json();
      setRuns(data.runs || []);
    } catch (err) {
      console.error('Failed to fetch subagent runs:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRuns();
    
    // Refresh runs list every 10 seconds
    const interval = setInterval(fetchRuns, 10000);
    return () => clearInterval(interval);
  }, []);

  // Listen for SSE events to trigger refresh
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      let payload: { event: string };
      try { 
        payload = JSON.parse(e.data); 
      } catch { 
        return; 
      }
      if (payload.event === 'subagent:complete' || payload.event === 'subagent:failed') {
        fetchRuns();
      }
    };

    window.addEventListener('sse:message' as any, handler);
    return () => window.removeEventListener('sse:message' as any, handler);
  }, []);

  const handleSelectRun = (id: string, isLive: boolean) => {
    setSelectedRun({ id, isLive });
  };

  const handleCloseDrawer = () => {
    setSelectedRun(null);
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '16px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)'
      }}>
        <h2 style={{ 
          margin: 0, 
          fontSize: '18px', 
          fontWeight: 600,
          color: 'var(--text)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <span>⚙️</span>
          Subagent Sessions
        </h2>
        <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--text-dim)' }}>
          Click a run to view its full execution transcript
        </p>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-dim)' }}>
            Loading runs...
          </div>
        ) : (
          <SubagentRunsList runs={runs} onSelectRun={handleSelectRun} />
        )}
      </div>

      {selectedRun && (
        <SessionViewerDrawer
          runId={selectedRun.id}
          isLive={selectedRun.isLive}
          onClose={handleCloseDrawer}
        />
      )}
    </div>
  );
};
