/**
 * MessageList - Scrollable message history with streaming support
 */

import React, { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TimelineItem } from '../hooks/useMessages';
import { ToolCall } from '../hooks/useSSE';
import { Message } from './Message';
import { ToolCallCard } from './ToolCallCard';
import { ThinkingBlock } from './ThinkingBlock';
import { StreamingMessageBlocks } from './StreamingMessageBlocks';
import type { StreamingMessage } from '../hooks/useSSE';

interface MessageListProps {
  messages: TimelineItem[];
  streamingText?: string;
  thinkingText?: string;
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
  streamingMessage?: StreamingMessage | null;
}

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  streamingText = '',
  thinkingText = '',
  toolCalls = [],
  isStreaming = false,
  streamingMessage = null,
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Always scroll to bottom when a new committed message arrives or streaming starts/ends.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingMessage]);

  // Mid-stream updates (thinking tokens, tool call updates): only scroll if
  // already near the bottom so we don't hijack the user's scroll position.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 200) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [streamingText, thinkingText, toolCalls]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        scrollBehavior: 'smooth',
        minWidth: 0,
      }}
    >
      {messages.length === 0 && !isStreaming && (
        <div
          style={{
            color: 'var(--text-dim)',
            fontSize: '13px',
            padding: '8px 0',
            textAlign: 'center',
            marginTop: '40px',
          }}
        >
          No messages yet. Say hello!
        </div>
      )}

      {messages.map((msg) => {
        if (msg.kind === 'thinking') {
          return <ThinkingBlock key={msg.id} content={msg.text || ''} />;
        }
        if (msg.kind === 'tool_call') {
          return (
            <ToolCallCard
              key={msg.id}
              toolCall={{
                id: msg.id,
                toolName: msg.toolName || 'tool',
                args: msg.args,
                status: msg.status || 'success',
                resultText: msg.resultText,
              }}
            />
          );
        }
        if (msg.kind === 'blocks' && msg.blocks?.length) {
          return (
            <StreamingMessageBlocks
              key={msg.id}
              message={{ role: 'assistant', content: msg.blocks }}
              isStreaming={false}
            />
          );
        }
        return <Message key={msg.id} message={msg} />;
      })}

      {/* Active tool calls (before streaming message) */}
      {toolCalls.map((toolCall) => (
        <ToolCallCard key={toolCall.id} toolCall={toolCall} />
      ))}

      {/* Thinking block during streaming — only shown in fallback path */}
      {!streamingMessage && thinkingText && <ThinkingBlock content={thinkingText} isStreaming={isStreaming} />}

      {/* Phase 2: Render full content blocks when available */}
      {streamingMessage ? (
        <StreamingMessageBlocks message={streamingMessage} isStreaming={isStreaming} />
      ) : streamingText && (
        <div
          className="msg agent streaming"
          style={{
            maxWidth: 'min(85%, 100%)',
            minWidth: 0,
            padding: '12px 16px',
            borderRadius: 'var(--radius)',
            fontSize: '16px',
            lineHeight: 1.75,
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
            alignSelf: 'flex-start',
            background: 'linear-gradient(135deg, #1a0e02, #0c0a09)',
            border: '1px solid var(--accent)',
            boxShadow: '0 0 12px rgba(217,119,6,0.25)',
          }}
        >
          <div className="message-content">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                pre: ({ children }) => (
                  <pre
                    style={{
                      background: 'rgba(0,0,0,0.3)',
                      padding: '8px',
                      borderRadius: '4px',
                      overflowX: 'auto',
                      margin: '8px 0',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '13px',
                    }}
                  >
                    {children}
                  </pre>
                ),
                code: ({ inline, children, ...props }: any) =>
                  inline ? (
                    <code
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '14px',
                        background: 'rgba(0,0,0,0.3)',
                        padding: '1px 4px',
                        borderRadius: '3px',
                      }}
                      {...props}
                    >
                      {children}
                    </code>
                  ) : (
                    <code style={{ fontFamily: 'var(--font-mono)', fontSize: '13px' }} {...props}>
                      {children}
                    </code>
                  ),
                strong: ({ children }) => (
                  <strong style={{ color: 'var(--text)' }}>{children}</strong>
                ),
                em: ({ children }) => <em style={{ color: 'var(--text-dim)' }}>{children}</em>,
              }}
            >
              {streamingText}
            </ReactMarkdown>
          </div>
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  );
};
