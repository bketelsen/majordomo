/**
 * Hook for managing SSE connection and streaming updates
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { TimelineItem } from './useMessages';
// Local type matching pi-ai's AssistantMessage shape (avoid cross-package dep)
export interface StreamingContentBlock {
  type: 'text' | 'thinking' | 'toolCall' | 'tool_result';
  text?: string;           // type: text
  thinking?: string;       // type: thinking
  id?: string;             // type: toolCall
  name?: string;           // type: toolCall
  arguments?: Record<string, unknown>; // type: toolCall (pi uses 'arguments' not 'input')
  input?: Record<string, unknown>;     // alias
  content?: string;        // type: tool_result
}
export interface StreamingMessage {
  role: 'assistant';
  content: StreamingContentBlock[];
}

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
  streamingMessage: StreamingMessage | null;  // Phase 2: Full message state
}

export function useSSE(activeDomain: string) {
  const activeDomainRef = useRef(activeDomain);
  activeDomainRef.current = activeDomain; // keep ref in sync without re-running effect
  const [state, setState] = useState<SSEState>({
    isConnected: false,
    isStreaming: false,
    streamingText: '',
    thinkingText: '',
    toolCalls: [],
    suggestedSwitch: null,
    newMessage: null,
    streamingMessage: null,
  });

  const clearStreamingState = useCallback(() => {
    setState(prev => ({
      ...prev,
      isStreaming: false,
      streamingText: '',
      thinkingText: '',
      toolCalls: [],
      streamingMessage: null,
    }));
  }, []);

  useEffect(() => {
    let evtSource: EventSource | null = null;
    let destroyed = false;
    let retryDelay = 1000; // Start at 1s
    const maxRetryDelay = 16000; // Cap at 16s

    function connect() {
      if (destroyed) return;
      evtSource = new EventSource('/sse');

      evtSource.onopen = () => {
        setState(prev => ({ ...prev, isConnected: true }));
        retryDelay = 1000; // Reset backoff on successful connection
      };

      evtSource.onerror = () => {
        setState(prev => ({ ...prev, isConnected: false }));
        evtSource?.close();
        // Exponential backoff with jitter
        if (!destroyed) {
          const jitter = Math.random() * 0.3 * retryDelay; // ±30% jitter
          const delayWithJitter = retryDelay + jitter;
          setTimeout(connect, delayWithJitter);
          retryDelay = Math.min(retryDelay * 2, maxRetryDelay); // Double, cap at max
        }
      };

      evtSource.onmessage = (e) => {
        let payload: { event: string; data: any };
        try {
          payload = JSON.parse(e.data);
        } catch {
          return;
        }

        const { event, data } = payload;

        // Guard: some events have no data (e.g. 'connected')
        if (!data) return;

        // Only process events for the active domain (except domain events)
        if (data.domain && data.domain !== activeDomainRef.current && !event.startsWith('domain:')) {
          return;
        }

        switch (event) {
          case 'agent:token':
            setState(prev => {
              // Phase 2: skip redundant streamingText update when streamingMessage is active.
              // agent:message_update already handles the full render; updating streamingText
              // here causes a second render per token AND triggers the scrollIntoView effect
              // in MessageList even though streamingText is not displayed — pure CPU waste.
              if (prev.streamingMessage) return prev;
              return {
                ...prev,
                isStreaming: true,
                streamingText: prev.streamingText + data.delta,
                thinkingText: '', // Clear thinking when text starts
              };
            });
            break;

          case 'agent:thinking':
            setState(prev => ({
              ...prev,
              isStreaming: true,
              thinkingText: prev.thinkingText + data.delta,
            }));
            break;

          case 'agent:message_update':
            setState(prev => ({
              ...prev,
              isStreaming: true,
              streamingMessage: data.message,
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
                // If we have a streamingMessage with content blocks, preserve them
                kind: prev.streamingMessage?.content?.length ? 'blocks' : 'chat',
                role: 'assistant',
                text: data.text,
                blocks: prev.streamingMessage?.content,
                timestamp: Date.now(),
              },
            }));
            setTimeout(clearStreamingState, 1500);
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
      destroyed = true;
      evtSource?.close();
    };
  }, []); // SSE connects once — domain filtering uses ref, no reconnect needed

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
