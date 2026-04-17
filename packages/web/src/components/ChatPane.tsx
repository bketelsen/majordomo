/**
 * ChatPane - Main chat container that coordinates messages, SSE, and input
 */

import React, { useEffect, useState } from 'react';
import { useMessages } from '../hooks/useMessages';
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

  const [allMessages, setAllMessages] = useState(messages);

  // Propagate SSE connection state up to App for the header badge
  useEffect(() => {
    onConnectionChange?.(isConnected);
  }, [isConnected, onConnectionChange]);

  // Update messages when they change from the hook
  useEffect(() => {
    setAllMessages(messages);
  }, [messages]);

  // When agent:done fires, just reload from DB — the streaming content is already
  // visible. Optimistically pushing the message creates a duplicate that flickers
  // until the reload resolves.
  useEffect(() => {
    if (newMessage) {
      clearNewMessage();
      setTimeout(() => reload(), 500);
    }
  }, [newMessage, clearNewMessage]);

  const handleSendMessage = async (text: string) => {
    // Optimistically add user message
    const userMessage = {
      id: `u-${Date.now()}`,
      kind: 'chat' as const,
      role: 'user' as const,
      text,
      timestamp: Date.now(),
    };
    setAllMessages((prev) => [...prev, userMessage]);

    try {
      const res = await fetch(`/api/messages/${activeDomain}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Request failed' }));
        const errorMessage = {
          id: `e-${Date.now()}`,
          kind: 'chat' as const,
          role: 'assistant' as const,
          text: `❌ ${err.error ?? 'Request failed'}`,
          timestamp: Date.now(),
        };
        setAllMessages((prev) => [...prev, errorMessage]);
      }
    } catch (err) {
      const errorMessage = {
        id: `e-${Date.now()}`,
        kind: 'chat' as const,
        role: 'assistant' as const,
        text: `❌ Network error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        timestamp: Date.now(),
      };
      setAllMessages((prev) => [...prev, errorMessage]);
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
          streamingText={streamingText}
          thinkingText={thinkingText}
          toolCalls={toolCalls}
          isStreaming={isStreaming}
          streamingMessage={streamingMessage}
        />
      )}

      <InputArea onSend={handleSendMessage} disabled={isStreaming} isStreaming={isStreaming} onStop={handleStop} />
    </div>
  );
};
