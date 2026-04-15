/**
 * InputArea - Textarea and send button for message input
 */

import React, { useState, useRef, useEffect, KeyboardEvent } from 'react';

interface InputAreaProps {
  onSend: (text: string) => void;
  disabled?: boolean;
}

export const InputArea: React.FC<InputAreaProps> = ({ onSend, disabled = false }) => {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px';
    }
  }, [text]);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      style={{
        padding: '12px 16px',
        borderTop: '1px solid var(--border)',
        background: 'var(--surface)',
        display: 'flex',
        gap: '8px',
        paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
        minWidth: 0,
      }}
    >
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Message Majordomo…"
        rows={1}
        disabled={disabled}
        style={{
          flex: '1 1 auto',
          minWidth: 0,
          background: 'var(--surface2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: '8px 12px',
          color: 'var(--text)',
          fontFamily: 'var(--font)',
          fontSize: '16px',
          resize: 'none',
          minHeight: '40px',
          maxHeight: '120px',
          outline: 'none',
          transition: 'border-color 0.15s',
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = 'var(--accent)';
          e.currentTarget.style.boxShadow = '0 0 0 2px rgba(217,119,6,0.15)';
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = 'var(--border)';
          e.currentTarget.style.boxShadow = 'none';
        }}
      />
      <button
        onClick={handleSend}
        disabled={disabled || !text.trim()}
        style={{
          padding: '8px 16px',
          background: disabled
            ? 'var(--accent-dim)'
            : 'linear-gradient(135deg, var(--accent), var(--accent-dim))',
          border: 'none',
          borderRadius: 'var(--radius)',
          color: '#0c0a09',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontSize: '12px',
          fontWeight: 700,
          transition: 'all 0.15s',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          fontFamily: 'var(--font)',
          touchAction: 'manipulation',
          minHeight: '44px',
          flexShrink: 0,
          opacity: disabled ? 0.6 : 1,
        }}
        onMouseEnter={(e) => {
          if (!disabled) {
            e.currentTarget.style.background = 'linear-gradient(135deg, #f59e0b, var(--accent))';
          }
        }}
        onMouseLeave={(e) => {
          if (!disabled) {
            e.currentTarget.style.background =
              'linear-gradient(135deg, var(--accent), var(--accent-dim))';
          }
        }}
      >
        Send
      </button>
    </div>
  );
};
