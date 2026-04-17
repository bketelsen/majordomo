/**
 * Hook for loading message history
 */

import { useState, useEffect } from 'react';
import type { StreamingContentBlock } from './useSSE';

export interface TimelineItem {
  id: string;
  kind: 'chat' | 'thinking' | 'tool_call' | 'blocks';
  role?: 'user' | 'assistant';
  text?: string;
  blocks?: StreamingContentBlock[];  // kind: 'blocks'
  source?: string;
  toolName?: string;
  args?: unknown;
  resultText?: string;
  status?: 'running' | 'success' | 'error';
  timestamp: number;
}

export interface MessagesState {
  messages: TimelineItem[];
  loading: boolean;
  error: string | null;
}

export function useMessages(domain: string) {
  const [state, setState] = useState<MessagesState>({
    messages: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    loadMessages();
  }, [domain]);

  async function loadMessages() {
    setState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const res = await fetch(`/api/messages/${domain}?limit=80`);
      if (!res.ok) {
        throw new Error('Failed to load messages');
      }
      const data = await res.json();
      setState({
        messages: data.messages ?? [],
        loading: false,
        error: null,
      });
    } catch (err) {
      setState({
        messages: [],
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load messages',
      });
    }
  }

  return {
    ...state,
    reload: loadMessages,
  };
}
