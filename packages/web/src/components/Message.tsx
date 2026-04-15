/**
 * Message - Renders a single message with markdown support
 */

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TimelineItem } from '../hooks/useMessages';

interface MessageProps {
  message: TimelineItem;
}

export const Message: React.FC<MessageProps> = ({ message }) => {
  if (!message.text) return null;

  const roleClass = message.role === 'assistant' ? 'agent' : message.role;

  return (
    <div
      className={`msg ${roleClass}`}
      data-id={message.id}
      style={{
        maxWidth: 'min(85%, 100%)',
        minWidth: 0,
        padding: '12px 16px',
        borderRadius: 'var(--radius)',
        fontSize: '16px',
        lineHeight: 1.75,
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
        alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
        background:
          message.role === 'user'
            ? 'linear-gradient(135deg, #292524, #1c1917)'
            : 'linear-gradient(135deg, #1a0e02, #0c0a09)',
        border:
          message.role === 'user'
            ? '1px solid rgba(120,53,15,0.5)'
            : '1px solid rgba(120,53,15,0.4)',
      }}
    >
      {message.source && (
        <div
          style={{
            fontSize: '11px',
            color: 'var(--text-dim)',
            marginBottom: '4px',
          }}
        >
          {message.source}
        </div>
      )}
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
            strong: ({ children }) => <strong style={{ color: 'var(--text)' }}>{children}</strong>,
            em: ({ children }) => <em style={{ color: 'var(--text-dim)' }}>{children}</em>,
          }}
        >
          {message.text}
        </ReactMarkdown>
      </div>
    </div>
  );
};
