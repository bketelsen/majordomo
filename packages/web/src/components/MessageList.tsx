/**
 * MessageList - Clean, consolidated message rendering with streaming support
 * Replaces the previous fragmented implementation with a single, maintainable component
 */

import React, { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TimelineItem } from '../hooks/useMessages';
import { ToolCall, StreamingContentBlock, StreamingMessage } from '../hooks/useSSE';

interface MessageListProps {
  messages: TimelineItem[];
  streamingText?: string;
  thinkingText?: string;
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
  streamingMessage?: StreamingMessage | null;
}

// Markdown styling components
const markdownComponents = {
  pre: ({ children }: any) => (
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
  strong: ({ children }: any) => <strong style={{ color: 'var(--text)' }}>{children}</strong>,
  em: ({ children }: any) => <em style={{ color: 'var(--text-dim)' }}>{children}</em>,
};

// ThinkingBlock component
const ThinkingBlock: React.FC<{ content: string; isStreaming?: boolean }> = ({ content, isStreaming }) => {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div
      style={{
        alignSelf: 'flex-start',
        maxWidth: 'min(85%, 100%)',
        borderRadius: 'var(--radius)',
        padding: '10px 12px',
        border: '1px solid rgba(251, 191, 36, 0.22)',
        background: 'rgba(251, 191, 36, 0.08)',
        color: 'var(--text)',
      }}
    >
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '12px',
          fontWeight: 600,
          color: 'var(--warning)',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span>💭</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>Thinking</span>
        {isStreaming && (
          <span
            style={{
              display: 'inline-block',
              width: '10px',
              height: '10px',
              border: '1.5px solid var(--warning)',
              borderTopColor: 'transparent',
              borderRadius: '50%',
              animation: 'spin 0.7s linear infinite',
            }}
          />
        )}
        <span
          style={{
            fontSize: '10px',
            color: 'var(--text-dim)',
            marginLeft: 'auto',
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 0.2s',
          }}
        >
          ▾
        </span>
      </div>
      {expanded && (
        <div
          style={{
            marginTop: '8px',
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            background: 'rgba(0,0,0,0.28)',
            padding: '6px 8px',
            borderRadius: '4px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            lineHeight: 1.5,
          }}
        >
          {content}
        </div>
      )}
    </div>
  );
};

// ToolCallBlock component
const ToolCallBlock: React.FC<{ toolCall: ToolCall }> = ({ toolCall }) => {
  const [expanded, setExpanded] = React.useState(toolCall.status === 'error');

  const getSubtitle = () => {
    const args = toolCall.args as any;
    if (!args) return '';
    if (args.command) return args.command;
    if (args.file_path) return args.file_path;
    if (args.path) return args.path;
    if (args.query) return args.query;
    for (const key in args) {
      const val = args[key];
      if (typeof val === 'string' && val.length > 0 && val.length < 100) {
        return val;
      }
    }
    return '';
  };

  const icon = toolCall.status === 'error' ? '✗' : toolCall.status === 'success' ? '✓' : '▸';
  const statusText = toolCall.status === 'error' ? 'error' : toolCall.status === 'success' ? 'done' : 'running';
  const subtitle = getSubtitle();

  return (
    <div
      style={{
        alignSelf: 'flex-start',
        maxWidth: 'min(85%, 100%)',
        borderRadius: 'var(--radius)',
        padding: '10px 12px',
        border: '1px solid rgba(124, 106, 247, 0.22)',
        background: 'rgba(124, 106, 247, 0.06)',
        color: 'var(--text)',
      }}
    >
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '12px',
          fontWeight: 600,
          color: 'var(--accent)',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span
          style={{
            color:
              toolCall.status === 'error'
                ? 'var(--error)'
                : toolCall.status === 'success'
                ? 'var(--success)'
                : 'inherit',
          }}
        >
          {icon}
        </span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>{toolCall.toolName}</span>
        {toolCall.status === 'running' && (
          <span
            style={{
              display: 'inline-block',
              width: '10px',
              height: '10px',
              border: '1.5px solid var(--accent)',
              borderTopColor: 'transparent',
              borderRadius: '50%',
              animation: 'spin 0.7s linear infinite',
            }}
          />
        )}
        <span
          style={{
            fontSize: '11px',
            color:
              toolCall.status === 'error'
                ? 'var(--error)'
                : toolCall.status === 'success'
                ? 'var(--success)'
                : 'var(--text-dim)',
            marginLeft: 'auto',
          }}
        >
          {statusText}
        </span>
        <span
          style={{
            fontSize: '10px',
            color: 'var(--text-dim)',
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 0.2s',
          }}
        >
          ▾
        </span>
      </div>
      {expanded && (
        <>
          {subtitle && (
            <div
              style={{
                fontSize: '11px',
                color: 'var(--text-dim)',
                marginTop: '4px',
                marginLeft: '22px',
              }}
            >
              {subtitle}
            </div>
          )}
          {toolCall.args && (
            <div style={{ marginTop: '8px' }}>
              <div
                style={{
                  fontSize: '10px',
                  color: 'var(--text-dim)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginBottom: '4px',
                }}
              >
                Arguments
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '12px',
                  background: 'rgba(0,0,0,0.28)',
                  padding: '6px 8px',
                  borderRadius: '4px',
                  whiteSpace: 'pre-wrap',
                  overflowX: 'auto',
                }}
              >
                {JSON.stringify(toolCall.args, null, 2)}
              </div>
            </div>
          )}
          {toolCall.resultText && (
            <div style={{ marginTop: '8px' }}>
              <div
                style={{
                  fontSize: '10px',
                  color: 'var(--text-dim)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginBottom: '4px',
                }}
              >
                Result
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '12px',
                  background: 'rgba(0,0,0,0.28)',
                  padding: '6px 8px',
                  borderRadius: '4px',
                  whiteSpace: 'pre-wrap',
                  overflowX: 'auto',
                }}
              >
                {toolCall.resultText}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

// Message component
const MessageBubble: React.FC<{ message: TimelineItem }> = ({ message }) => {
  if (!message.text) return null;

  return (
    <div
      style={{
        maxWidth: 'min(85%, 100%)',
        padding: '12px 16px',
        borderRadius: 'var(--radius)',
        fontSize: '16px',
        lineHeight: 1.75,
        alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
        background:
          message.role === 'user'
            ? 'linear-gradient(135deg, #292524, #1c1917)'
            : 'linear-gradient(135deg, #1a0e02, #0c0a09)',
        border:
          message.role === 'user' ? '1px solid rgba(120,53,15,0.5)' : '1px solid rgba(120,53,15,0.4)',
      }}
    >
      {message.source && (
        <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px' }}>
          {message.source}
        </div>
      )}
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {message.text}
      </ReactMarkdown>
    </div>
  );
};

// StreamingBlocks component
const StreamingBlocks: React.FC<{ message: StreamingMessage; isStreaming: boolean }> = ({
  message,
  isStreaming,
}) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '85%', alignSelf: 'flex-start' }}>
      {message.content.map((block: StreamingContentBlock, idx: number) => {
        if (block.type === 'text') {
          return (
            <div
              key={idx}
              style={{
                padding: '12px 16px',
                borderRadius: 'var(--radius)',
                background: 'linear-gradient(135deg, #1a0e02, #0c0a09)',
                border: '1px solid rgba(120,53,15,0.4)',
                fontSize: '16px',
                lineHeight: 1.75,
              }}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {block.text || ''}
              </ReactMarkdown>
            </div>
          );
        }

        if (block.type === 'thinking') {
          return (
            <ThinkingBlock
              key={idx}
              content={block.thinking || ''}
              isStreaming={isStreaming && idx === message.content.length - 1}
            />
          );
        }

        if (block.type === 'toolCall') {
          return (
            <ToolCallBlock
              key={idx}
              toolCall={{
                id: block.id || `tool-${idx}`,
                toolName: block.name || 'tool',
                args: block.arguments ?? block.input,
                status: 'running',
              }}
            />
          );
        }

        return null;
      })}
    </div>
  );
};

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

  // New committed message (count changed): smooth scroll to bottom.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // Streaming updates: instant scroll — invisible if already at bottom,
  // no animation jank if not. Never fights the user.
  useEffect(() => {
    if (!isStreaming) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [streamingMessage, streamingText, isStreaming]);

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
        minWidth: 0,
      }}
    >
      {messages.length === 0 && !isStreaming && (
        <div
          style={{
            color: 'var(--text-dim)',
            fontSize: '13px',
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
            <ToolCallBlock
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
          return <StreamingBlocks key={msg.id} message={{ role: 'assistant', content: msg.blocks }} isStreaming={false} />;
        }
        return <MessageBubble key={msg.id} message={msg} />;
      })}

      {/* Active tool calls */}
      {toolCalls.map((toolCall) => (
        <ToolCallBlock key={toolCall.id} toolCall={toolCall} />
      ))}

      {/* Thinking block during streaming */}
      {!streamingMessage && thinkingText && <ThinkingBlock content={thinkingText} isStreaming={isStreaming} />}

      {/* Full streaming message blocks */}
      {streamingMessage ? (
        <StreamingBlocks message={streamingMessage} isStreaming={isStreaming} />
      ) : (
        streamingText && (
          <div
            style={{
              maxWidth: 'min(85%, 100%)',
              padding: '12px 16px',
              borderRadius: 'var(--radius)',
              fontSize: '16px',
              lineHeight: 1.75,
              alignSelf: 'flex-start',
              background: 'linear-gradient(135deg, #1a0e02, #0c0a09)',
              border: '1px solid var(--accent)',
              boxShadow: '0 0 12px rgba(217,119,6,0.25)',
            }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {streamingText}
            </ReactMarkdown>
          </div>
        )
      )}

      <div ref={messagesEndRef} style={{ overflowAnchor: 'auto', height: '1px' }} />
    </div>
  );
};
