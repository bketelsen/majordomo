/**
 * ChatPane - Main chat container that coordinates messages, SSE, and input
 */

import React, { useEffect, useRef, useState } from 'react';
import { useMessages, TimelineItem } from '../hooks/useMessages';
import { useSSE, DomainSwitchSuggestion } from '../hooks/useSSE';
import { MessageList } from './MessageList';
import { InputArea } from './InputArea';

interface ChatPaneProps {
  activeDomain: string;
  onDomainEvent?: (event: string) => void;
  onConnectionChange?: (connected: boolean) => void;
}

const DomainSwitchBanner: React.FC<{
  suggestion: DomainSwitchSuggestion;
  onAccept: () => void;
  onDecline: () => void;
  onDismiss: () => void;
}> = ({ suggestion, onAccept, onDecline, onDismiss }) => {
  return (
    <div
      style={{
        display: 'flex',
        padding: '10px 16px',
        background: 'rgba(124,106,247,0.12)',
        borderBottom: '1px solid var(--accent)',
        alignItems: 'center',
        gap: '12px',
        fontSize: '13px',
        animation: 'slideDown 0.2s ease',
      }}
    >
      <span style={{ fontSize: '16px' }}>💡</span>
      <div style={{ flex: 1 }}>
        <div style={{ color: 'var(--text)' }}>
          Switch to <strong style={{ color: 'var(--accent)' }}>{suggestion.to}</strong> domain?
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '2px' }}>
          {suggestion.reason}
        </div>
      </div>
      <button
        onClick={onAccept}
        style={{
          padding: '5px 12px',
          border: '1px solid var(--accent)',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '12px',
          transition: 'all 0.15s',
          background: 'var(--accent)',
          color: 'white',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = '#9080ff';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'var(--accent)';
        }}
      >
        Yes
      </button>
      <button
        onClick={onDecline}
        style={{
          padding: '5px 12px',
          border: '1px solid var(--border)',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '12px',
          transition: 'all 0.15s',
          background: 'var(--surface2)',
          color: 'var(--text)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--surface)';
          e.currentTarget.style.borderColor = 'var(--accent)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'var(--surface2)';
          e.currentTarget.style.borderColor = 'var(--border)';
        }}
      >
        No
      </button>
      <span
        onClick={onDismiss}
        style={{
          cursor: 'pointer',
          color: 'var(--text-dim)',
          fontSize: '14px',
          padding: '0 4px',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--text)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--text-dim)';
        }}
      >
        ×
      </span>
    </div>
  );
};

export const ChatPane: React.FC<ChatPaneProps> = ({ activeDomain, onDomainEvent, onConnectionChange }) => {
  const { messages, loading, reload } = useMessages(activeDomain);
  const {
    isConnected,
    isStreaming,
    streamingText,
    thinkingText,
    toolCalls,
    suggestedSwitch,
    newMessage,
    streamingMessage,
    dismissSuggestion,
    clearNewMessage,
  } = useSSE(activeDomain, onDomainEvent);

  // Only track optimistic user messages — everything else comes from useMessages directly.
  const [optimisticMessages, setOptimisticMessages] = useState<TimelineItem[]>([]);

  // Snapshot message count when streaming starts (inline, synchronous).
  const wasStreamingRef = useRef(false);
  const streamStartLengthRef = useRef(0);
  if (isStreaming && !wasStreamingRef.current) {
    streamStartLengthRef.current = messages.length;
  }
  wasStreamingRef.current = isStreaming;

  // Keep the last known streaming content in a ref so we can show it
  // after clearStreamingState fires (streamingMessage goes null) until
  // the reload confirms the committed message is in messages.
  const lastStreamingMessageRef = useRef<typeof streamingMessage>(null);
  if (streamingMessage) lastStreamingMessageRef.current = streamingMessage;

  // Use the frozen snapshot when streamingMessage has cleared but reload hasn't landed yet.
  // Goes null atomically in the same render that messages.length grows.
  const effectiveStreamingMessage = messages.length <= streamStartLengthRef.current
    ? (streamingMessage ?? lastStreamingMessageRef.current)
    : null;

  // While streaming content is visible, only show pre-stream messages (no double).
  const baseMessages = effectiveStreamingMessage
    ? messages.slice(0, streamStartLengthRef.current)
    : messages;
  const allMessages = [...baseMessages, ...optimisticMessages];

  // Propagate SSE connection state up to App for the header badge
  useEffect(() => {
    onConnectionChange?.(isConnected);
  }, [isConnected, onConnectionChange]);

  // When agent:done fires, reload from DB after a brief delay to ensure
  // the JSONL has been flushed before we read it.
  useEffect(() => {
    if (newMessage) {
      clearNewMessage();
      setTimeout(() => reload().finally(() => setOptimisticMessages([])), 300);
    }
  }, [newMessage, clearNewMessage]);

  const handleSendMessage = async (text: string) => {
    // Optimistically add user message
    const userMessage: TimelineItem = {
      id: `u-${Date.now()}`,
      kind: 'chat' as const,
      role: 'user' as const,
      text,
      timestamp: Date.now(),
    };
    setOptimisticMessages(prev => [...prev, userMessage]);

    try {
      const res = await fetch(`/api/messages/${activeDomain}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Request failed' }));
        const errorMessage: TimelineItem = {
          id: `e-${Date.now()}`,
          kind: 'chat' as const,
          role: 'assistant' as const,
          text: `❌ ${err.error ?? 'Request failed'}`,
          timestamp: Date.now(),
        };
        setOptimisticMessages(prev => [...prev, errorMessage]);
      }
    } catch (err) {
      const errorMessage: TimelineItem = {
        id: `e-${Date.now()}`,
        kind: 'chat' as const,
        role: 'assistant' as const,
        text: `❌ Network error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        timestamp: Date.now(),
      };
      setOptimisticMessages(prev => [...prev, errorMessage]);
    }
  };

  const handleAcceptSwitch = async () => {
    if (!suggestedSwitch) return;
    dismissSuggestion();
    await handleSendMessage(`yes, switch to ${suggestedSwitch.to}`);
  };

  const handleDeclineSwitch = async () => {
    dismissSuggestion();
    await handleSendMessage('no, stay in current domain');
  };

  const handleStop = async () => {
    try {
      await fetch(`/api/stop/${activeDomain}`, { method: 'POST' });
    } catch (err) {
      console.error('Failed to stop generation:', err);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderRight: '1px solid var(--border)',
        overflow: 'hidden',
        minWidth: 0,
      }}
    >
      {suggestedSwitch && (
        <DomainSwitchBanner
          suggestion={suggestedSwitch}
          onAccept={handleAcceptSwitch}
          onDecline={handleDeclineSwitch}
          onDismiss={dismissSuggestion}
        />
      )}

      {loading ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-dim)',
          }}
        >
          Loading messages...
        </div>
      ) : (
        <MessageList
          messages={allMessages}
          streamingText={effectiveStreamingMessage ? '' : streamingText}
          thinkingText={effectiveStreamingMessage ? '' : thinkingText}
          toolCalls={effectiveStreamingMessage ? [] : toolCalls}
          isStreaming={isStreaming}
          streamingMessage={effectiveStreamingMessage}
        />
      )}

      <InputArea onSend={handleSendMessage} disabled={isStreaming} isStreaming={isStreaming} onStop={handleStop} />
    </div>
  );
};
