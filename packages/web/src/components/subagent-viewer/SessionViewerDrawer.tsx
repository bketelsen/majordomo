/**
 * SessionViewerDrawer - Slide-in panel showing full subagent session transcript
 */

import React, { useState, useEffect, useRef } from 'react';

interface JSONLEvent {
  type: string;
  [key: string]: unknown;
}

interface SessionViewerDrawerProps {
  runId: string;
  isLive: boolean;
  onClose: () => void;
}

function parseJSONL(jsonl: string): JSONLEvent[] {
  return jsonl
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean) as JSONLEvent[];
}

const EventRenderer: React.FC<{ event: JSONLEvent }> = ({ event }) => {
  const [expanded, setExpanded] = useState(false);

  // Message events
  if (event.type === 'message' || event.type === 'message_end') {
    const message = event.message as any;
    if (!message) return null;
    
    const role = message.role || 'unknown';
    const content = message.content || [];
    const textParts = content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('');

    if (!textParts) return null;

    return (
      <div style={{
        padding: '10px 12px',
        marginBottom: '8px',
        background: role === 'user' ? 'var(--surface2)' : 'transparent',
        borderLeft: `3px solid ${role === 'user' ? 'var(--accent)' : 'var(--success)'}`,
        borderRadius: '4px'
      }}>
        <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginBottom: '4px', textTransform: 'uppercase', fontWeight: 600 }}>
          {role}
        </div>
        <div style={{ fontSize: '13px', lineHeight: '1.5', whiteSpace: 'pre-wrap', color: 'var(--text)' }}>
          {textParts}
        </div>
      </div>
    );
  }

  // Thinking blocks
  if (event.type === 'thinking') {
    const content = (event.content as string) || '';
    return (
      <div style={{ marginBottom: '8px' }}>
        <div
          onClick={() => setExpanded(!expanded)}
          style={{
            cursor: 'pointer',
            padding: '8px 12px',
            background: 'var(--surface2)',
            borderLeft: '3px solid var(--warning)',
            borderRadius: '4px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}
        >
          <span style={{ fontSize: '10px', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>▶</span>
          <span style={{ fontSize: '11px', color: 'var(--warning)' }}>🤔 Agent thinking...</span>
        </div>
        {expanded && (
          <div style={{
            padding: '10px 12px',
            marginTop: '4px',
            background: 'var(--bg-secondary)',
            borderLeft: '3px solid var(--warning)',
            fontSize: '12px',
            color: 'var(--text-dim)',
            whiteSpace: 'pre-wrap',
            fontFamily: 'var(--font-mono)'
          }}>
            {content}
          </div>
        )}
      </div>
    );
  }

  // Tool use events
  if (event.type === 'tool_use') {
    const toolName = (event.name as string) || 'unknown';
    const input = event.input || {};
    
    return (
      <div style={{ marginBottom: '8px' }}>
        <div
          onClick={() => setExpanded(!expanded)}
          style={{
            cursor: 'pointer',
            padding: '8px 12px',
            background: 'var(--surface2)',
            borderLeft: '3px solid var(--accent)',
            borderRadius: '4px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}
        >
          <span style={{ fontSize: '10px', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>▶</span>
          <span style={{ fontSize: '11px', color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>🛠️ {toolName}</span>
        </div>
        {expanded && (
          <div style={{
            padding: '10px 12px',
            marginTop: '4px',
            background: 'var(--bg-secondary)',
            borderLeft: '3px solid var(--accent)',
            fontSize: '11px',
            color: 'var(--text-dim)',
            fontFamily: 'var(--font-mono)',
            overflowX: 'auto'
          }}>
            <pre style={{ margin: 0 }}>{JSON.stringify(input, null, 2)}</pre>
          </div>
        )}
      </div>
    );
  }

  // Tool result events
  if (event.type === 'tool_result') {
    const content = event.content || [];
    const textParts = (content as any[])
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('');
    
    if (!textParts) return null;

    return (
      <div style={{ marginBottom: '8px' }}>
        <div
          onClick={() => setExpanded(!expanded)}
          style={{
            cursor: 'pointer',
            padding: '8px 12px',
            background: 'var(--surface2)',
            borderLeft: '3px solid var(--success)',
            borderRadius: '4px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}
        >
          <span style={{ fontSize: '10px', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>▶</span>
          <span style={{ fontSize: '11px', color: 'var(--success)' }}>✓ Result</span>
        </div>
        {expanded && (
          <div style={{
            padding: '10px 12px',
            marginTop: '4px',
            background: 'var(--bg-secondary)',
            borderLeft: '3px solid var(--success)',
            fontSize: '11px',
            color: 'var(--text-dim)',
            whiteSpace: 'pre-wrap',
            fontFamily: 'var(--font-mono)',
            maxHeight: '400px',
            overflowY: 'auto'
          }}>
            {textParts}
          </div>
        )}
      </div>
    );
  }

  return null;
};

export const SessionViewerDrawer: React.FC<SessionViewerDrawerProps> = ({ runId, isLive, onClose }) => {
  const [events, setEvents] = useState<JSONLEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const eventsEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Auto-scroll to bottom when new events arrive (if autoScroll is enabled)
  useEffect(() => {
    if (autoScroll && eventsEndRef.current) {
      eventsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [events, autoScroll]);

  // Detect manual scroll to disable auto-scroll
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const isAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 50;
      setAutoScroll(isAtBottom);
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    if (isLive) {
      // Connect to SSE stream for live runs
      const eventSource = new EventSource(`/api/subagents/${runId}/stream`);
      
      eventSource.addEventListener('message', (e) => {
        try {
          const { events: newEvents } = JSON.parse(e.data);
          const parsed = parseJSONL(newEvents);
          setEvents(prev => {
            // Deduplicate events (SSE might send overlapping data)
            const existing = new Set(prev.map(e => JSON.stringify(e)));
            const unique = parsed.filter(e => !existing.has(JSON.stringify(e)));
            return [...prev, ...unique];
          });
          setLoading(false);
        } catch (err) {
          console.error('Failed to parse SSE event:', err);
        }
      });

      eventSource.onerror = () => {
        eventSource.close();
        setLoading(false);
      };

      return () => eventSource.close();
    } else {
      // Fetch complete session for finished runs
      fetch(`/api/subagents/${runId}/session`)
        .then(r => r.json())
        .then(data => {
          if (data.error) {
            setError(data.error);
          } else {
            const parsed = parseJSONL(data.jsonl);
            setEvents(parsed);
          }
          setLoading(false);
        })
        .catch(err => {
          setError(String(err));
          setLoading(false);
        });
    }
  }, [runId, isLive]);

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      right: 0,
      bottom: 0,
      width: 'min(600px, 100vw)',
      background: 'var(--bg-primary)',
      borderLeft: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 1000,
      boxShadow: '-4px 0 20px rgba(0,0,0,0.3)'
    }}>
      {/* Header */}
      <div style={{
        padding: '16px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        background: 'var(--bg-secondary)'
      }}>
        <span style={{ fontSize: '18px' }}>📜</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>
            Subagent Session
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
            {runId}
          </div>
        </div>
        {isLive && (
          <div style={{
            padding: '4px 8px',
            borderRadius: '4px',
            background: 'var(--warning)',
            color: 'var(--bg-primary)',
            fontSize: '10px',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '4px'
          }}>
            <span className="pulse-dot" />
            LIVE
          </div>
        )}
        <button
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--text-dim)',
            fontSize: '20px',
            cursor: 'pointer',
            padding: '4px 8px'
          }}
        >
          ✕
        </button>
      </div>

      {/* Events body */}
      <div
        ref={scrollContainerRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px'
        }}
      >
        {loading && (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-dim)' }}>
            Loading session...
          </div>
        )}
        
        {error && (
          <div style={{ padding: '16px', background: 'var(--error)', color: 'white', borderRadius: '4px' }}>
            {error}
          </div>
        )}

        {!loading && !error && events.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-dim)' }}>
            No session data yet
          </div>
        )}

        {events.map((event, idx) => (
          <EventRenderer key={idx} event={event} />
        ))}

        <div ref={eventsEndRef} />
      </div>

      {/* Auto-scroll indicator */}
      {!autoScroll && isLive && (
        <div
          onClick={() => {
            setAutoScroll(true);
            eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
          }}
          style={{
            position: 'absolute',
            bottom: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '8px 16px',
            background: 'var(--accent)',
            color: 'white',
            borderRadius: '20px',
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: 600,
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)'
          }}
        >
          ↓ Jump to bottom
        </div>
      )}
    </div>
  );
};
