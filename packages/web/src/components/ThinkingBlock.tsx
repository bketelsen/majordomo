/**
 * ThinkingBlock - Collapsible thinking display with spinner
 */

import React, { useState } from 'react';

interface ThinkingBlockProps {
  content: string;
  isStreaming?: boolean;
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ content, isStreaming = false }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`activity-block thinking-block ${expanded ? '' : 'collapsed'}`}
      style={{
        alignSelf: 'flex-start',
        width: 'min(85%, 100%)',
        borderRadius: 'var(--radius)',
        padding: '10px 12px',
        marginBottom: '8px',
        border: '1px solid rgba(251, 191, 36, 0.22)',
        background: 'rgba(251, 191, 36, 0.08)',
        color: 'var(--text)',
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
        transition: 'max-height 0.3s ease',
      }}
    >
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: expanded ? '8px' : '0',
          fontSize: '12px',
          fontWeight: 600,
          color: 'var(--warning)',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span style={{ flexShrink: 0 }}>💭</span>
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
              flexShrink: 0,
            }}
          />
        )}
        <span
          style={{
            fontSize: '10px',
            color: 'var(--text-dim)',
            transition: 'transform 0.2s',
            marginLeft: '6px',
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
          }}
        >
          ▾
        </span>
      </div>
      {expanded && !isStreaming && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            color: 'var(--text)',
            background: 'rgba(0,0,0,0.28)',
            padding: '6px 8px',
            borderRadius: '4px',
            overflowX: 'auto',
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
