/**
 * StreamingMessageBlocks - Renders full message content blocks during streaming.
 * Handles text, thinking, and tool_use blocks from the agent:message_update event.
 */

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import type { StreamingMessage, StreamingContentBlock } from '../hooks/useSSE';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCallCard } from './ToolCallCard';

interface StreamingMessageBlocksProps {
  message: StreamingMessage;
  isStreaming?: boolean;
}

export const StreamingMessageBlocks: React.FC<StreamingMessageBlocksProps> = ({
  message,
  isStreaming = false,
}) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '85%', alignSelf: 'flex-start' }}>
      {message.content.map((block: StreamingContentBlock, idx: number) => {
        if (block.type === 'text') {
          return (
            <div
              key={idx}
              className="msg agent"
              style={{
                padding: '12px 16px',
                borderRadius: 'var(--radius)',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                fontSize: '16px',
                lineHeight: 1.75,
                overflowWrap: 'anywhere',
                whiteSpace: 'pre-wrap',
              }}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
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
            <ToolCallCard
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
