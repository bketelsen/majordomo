/**
 * MessageList - nlux-powered chat UI for rendering and auto-scroll
 * nlux's composer is hidden; we use our existing InputArea
 */

import React, { useMemo } from 'react';
import { AiChat } from '@nlux/react';
import '@nlux/themes/nova.css';
import type { ChatItem } from '@nlux/react';
import { TimelineItem } from '../hooks/useMessages';

interface MessageListProps {
  messages: TimelineItem[];
  streamingText?: string;
}

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  streamingText = '',
}) => {
  // Convert TimelineItem[] to ChatItem[] and add streaming message if present
  const conversation = useMemo<ChatItem[]>(() => {
    const chatItems: ChatItem[] = messages
      .filter((msg) => msg.kind === 'chat' && msg.text)
      .map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        message: msg.text!,
      }));

    // Add streaming message as the last item
    if (streamingText) {
      chatItems.push({
        role: 'assistant',
        message: streamingText,
      });
    }

    return chatItems;
  }, [messages, streamingText]);

  // Dummy adapter - nlux requires one but we don't use it for sending
  const adapter = useMemo(() => ({
    streamText: async () => {
      // Not used - we handle sending via our InputArea
    },
  }), []);

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <style>{`
        /* Hide nlux composer - we use our own InputArea */
        .nlux-composer-container {
          display: none !important;
        }
        
        /* Customize nlux theme to match our dark theme */
        .nlux-AiChat-root {
          --nlux-ColorScheme: dark;
          --nlux-ChatRoom--BackgroundColor: transparent;
          height: 100%;
        }
        
        .nlux-conversation-container {
          padding: 16px;
        }
        
        .nlux-message-container {
          margin-bottom: 12px;
        }
        
        .nlux-message-received {
          background: linear-gradient(135deg, #1a0e02, #0c0a09) !important;
          border: 1px solid rgba(120,53,15,0.4) !important;
          color: var(--text) !important;
          border-radius: var(--radius) !important;
          padding: 12px 16px !important;
        }
        
        .nlux-message-sent {
          background: linear-gradient(135deg, #292524, #1c1917) !important;
          border: 1px solid rgba(120,53,15,0.5) !important;
          color: var(--text) !important;
          border-radius: var(--radius) !important;
          padding: 12px 16px !important;
        }
      `}</style>
      <AiChat
        adapter={adapter}
        initialConversation={conversation}
        conversationOptions={{
          autoScroll: true,
          layout: 'bubbles',
        }}
        displayOptions={{
          colorScheme: 'dark',
          width: '100%',
          height: '100%',
        }}
        personaOptions={{
          assistant: {
            name: 'Majordomo',
            avatar: '🤖',
          },
          user: {
            name: 'You',
          },
        }}
      />
    </div>
  );
};
