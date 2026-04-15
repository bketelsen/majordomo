/**
 * Hook for managing SSE connection and streaming updates
 */

import { useState, useEffect, useCallback } from 'react';
import { TimelineItem } from './useMessages';

export interface ToolCall {
  id: string;
  toolName: string;
  args?: unknown;
  status: 'running' | 'success' | 'error';
  resultText?: string;
}

export interface DomainSwitchSuggestion {
  from: string;
  to: string;
  reason: string;
}

export interface SSEState {
  isConnected: boolean;
  isStreaming: boolean;
  streamingText: string;
  thinkingText: string;
  toolCalls: ToolCall[];
  suggestedSwitch: DomainSwitchSuggestion | null;
  newMessage: TimelineItem | null;
}

export function useSSE(activeDomain: string) {
  const [state, setState] = useState<SSEState>({
    isConnected: false,
    isStreaming: false,
    streamingText: '',
    thinkingText: '',
    toolCalls: [],
    suggestedSwitch: null,
    newMessage: null,
  });

  const clearStreamingState = useCallback(() => {
    setState(prev => ({
      ...prev,
      isStreaming: false,
      streamingText: '',
      thinkingText: '',
      toolCalls: [],
    }));
  }, []);

  useEffect(() => {
    let evtSource: EventSource | null = null;

    function connect() {
      evtSource = new EventSource('/sse');

      evtSource.onopen = () => {
        setState(prev => ({ ...prev, isConnected: true }));
      };

      evtSource.onerror = () => {
        setState(prev => ({ ...prev, isConnected: false }));
        evtSource?.close();
        // Reconnect after 3 seconds
        setTimeout(connect, 3000);
      };

      evtSource.onmessage = (e) => {
        let payload: { event: string; data: any };
        try {
          payload = JSON.parse(e.data);
        } catch {
          return;
        }

        const { event, data } = payload;

        // Only process events for the active domain (except domain events)
        if (data.domain && data.domain !== activeDomain && !event.startsWith('domain:')) {
          return;
        }

        switch (event) {
          case 'agent:token':
            setState(prev => ({
              ...prev,
              isStreaming: true,
              streamingText: prev.streamingText + data.delta,
              thinkingText: '', // Clear thinking when text starts
            }));
            break;

          case 'agent:thinking':
            setState(prev => ({
              ...prev,
              isStreaming: true,
              thinkingText: prev.thinkingText + data.delta,
            }));
            break;

          case 'agent:tool_start':
            setState(prev => ({
              ...prev,
              toolCalls: [
                ...prev.toolCalls,
                {
                  id: `${data.toolName}-${Date.now()}`,
                  toolName: data.toolName,
                  args: data.args,
                  status: 'running',
                },
              ],
            }));
            break;

          case 'agent:tool_end':
            setState(prev => ({
              ...prev,
              toolCalls: prev.toolCalls.map((tc, idx) =>
                tc.toolName === data.toolName && idx === prev.toolCalls.filter(t => t.toolName === data.toolName).length - 1
                  ? {
                      ...tc,
                      status: data.isError ? 'error' : 'success',
                      resultText: data.result,
                    }
                  : tc
              ),
            }));
            break;

          case 'agent:done':
            setState(prev => ({
              ...prev,
              newMessage: {
                id: `a-${Date.now()}`,
                kind: 'chat',
                role: 'assistant',
                text: data.text,
                timestamp: Date.now(),
              },
            }));
            // Clear streaming state after a brief delay to allow UI to update
            setTimeout(clearStreamingState, 100);
            break;

          case 'agent:error':
            setState(prev => ({
              ...prev,
              newMessage: {
                id: `e-${Date.now()}`,
                kind: 'chat',
                role: 'assistant',
                text: `❌ ${data.error}`,
                timestamp: Date.now(),
              },
            }));
            setTimeout(clearStreamingState, 100);
            break;

          case 'domain:switch_suggested':
            setState(prev => ({
              ...prev,
              suggestedSwitch: {
                from: data.from,
                to: data.to,
                reason: data.reason,
              },
            }));
            // Auto-dismiss after 30 seconds
            setTimeout(() => {
              setState(prev => ({
                ...prev,
                suggestedSwitch: null,
              }));
            }, 30000);
            break;

          case 'domain:created':
          case 'domain:deleted':
          case 'domain:switched':
            // These are handled by the parent component
            break;
        }
      };
    }

    connect();

    return () => {
      evtSource?.close();
    };
  }, [activeDomain, clearStreamingState]);

  const dismissSuggestion = useCallback(() => {
    setState(prev => ({ ...prev, suggestedSwitch: null }));
  }, []);

  const clearNewMessage = useCallback(() => {
    setState(prev => ({ ...prev, newMessage: null }));
  }, []);

  return {
    ...state,
    dismissSuggestion,
    clearNewMessage,
  };
}
