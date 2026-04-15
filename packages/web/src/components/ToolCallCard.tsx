/**
 * ToolCallCard - Collapsible tool call with args and result
 */

import React, { useState } from 'react';
import { ToolCall } from '../hooks/useSSE';

interface ToolCallCardProps {
  toolCall: ToolCall;
}

function getToolSubtitle(toolName: string, args: any): string {
  if (!args) return '';

  // Bash tool - show command
  if (args.command) return args.command;

  // File operations - show path
  if (args.file_path) return args.file_path;
  if (args.path) return args.path;

  // Query-based tools
  if (args.query) return args.query;

  // Find first string value
  for (const key in args) {
    const val = args[key];
    if (typeof val === 'string' && val.length > 0 && val.length < 100) {
      return val;
    }
  }

  return '';
}

export const ToolCallCard: React.FC<ToolCallCardProps> = ({ toolCall }) => {
  const [expanded, setExpanded] = useState(toolCall.status === 'error');
  const subtitle = getToolSubtitle(toolCall.toolName, toolCall.args);

  const icon =
    toolCall.status === 'error' ? '✗' : toolCall.status === 'success' ? '✓' : '▸';
  const statusText =
    toolCall.status === 'error' ? 'error' : toolCall.status === 'success' ? 'done' : 'running';
  const statusClass =
    toolCall.status === 'error'
      ? 'activity-error'
      : toolCall.status === 'success'
      ? 'activity-success'
      : '';

  return (
    <div
      className={`activity-block tool-card ${expanded ? '' : 'collapsed'}`}
      data-tool={toolCall.toolName}
      style={{
        alignSelf: 'flex-start',
        width: 'min(85%, 100%)',
        borderRadius: 'var(--radius)',
        padding: '10px 12px',
        marginBottom: '8px',
        border: '1px solid rgba(124, 106, 247, 0.22)',
        background: 'rgba(124, 106, 247, 0.06)',
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
          color: 'var(--accent)',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span
          className={statusClass}
          style={{
            flexShrink: 0,
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
              flexShrink: 0,
            }}
          />
        )}
        <span
          className={statusClass}
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
            transition: 'transform 0.2s',
            marginLeft: '6px',
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
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
                margin: '-3px 0 8px 22px',
                wordBreak: 'break-word',
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
                {toolCall.resultText}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
