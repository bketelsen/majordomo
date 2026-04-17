# Chat UI Double-Render Debug Brief

## Task
Fix the remaining ~5% double-message / visual flicker in the Majordomo chat UI.

## What We Know

### The Symptom
After a streaming response completes, the assistant message briefly appears twice before resolving to one. Occasionally the list also flickers. Playwright traces confirm it.

### The Architecture
- `useSSE.ts` — SSE hook. Emits `streamingMessage` (full content blocks) per rAF frame during streaming. Fires `agent:done` → sets `newMessage`. Calls `clearStreamingState` 800ms after `agent:done`, which sets `streamingMessage = null`.
- `useMessages.ts` — fetches `/api/messages/:domain?limit=80` from DB. Called `reload()` 300ms after `agent:done`.
- `ChatPane.tsx` — coordinates the two. Uses `effectiveStreamingMessage` to decide whether to show streaming content or let committed messages through.
- `MessageList.tsx` — renders everything.

### The Core Problem
Two content sources overlap briefly:
1. `effectiveStreamingMessage` (frozen streaming snapshot) — stays visible until timestamp check flips
2. Committed messages from `messages` array (loaded by reload)

The timestamp check (`lastMessage.timestamp > streamStartTimestampRef.current`) is the gating mechanism. It should flip when reload lands. When it fails to flip in time, both show simultaneously.

### What's Been Tried (and failed or partially worked)
- Filtering messages array by timestamp → caused blank DOM frame (count→0)
- Slicing messages array by count → broken by limit=80 cap (count never changes)
- setTimeout-based clearStreamingState tuning → timing races
- `showStreaming` state driven by reload().finally() → React batching races

### Current State (as of last commit)
`effectiveStreamingMessage` goes null when EITHER:
- `messagesUpdated` is true (timestamp check passes), OR
- `agentDoneRef.current && !streamingMessage` (agent:done fired AND clearStreamingState cleared streamingMessage)

The second condition is the new fallback. It may still have a window where both are visible between agent:done and clearStreamingState firing.

### Playwright Debug Script
`/tmp/fresh_debug.py` — runs against `https://127.0.0.1:3000` (self-signed TLS). Sends "say exactly the word: pong", polls DOM every 100ms, logs transitions and duplicate text detection. Run it after the session is idle (10s quiet required).

## Files to Read
1. `/home/bjk/projects/sionapi/packages/web/src/components/ChatPane.tsx`
2. `/home/bjk/projects/sionapi/packages/web/src/components/MessageList.tsx`
3. `/home/bjk/projects/sionapi/packages/web/src/hooks/useSSE.ts` (read-only — do not modify)
4. `/home/bjk/projects/sionapi/packages/web/src/hooks/useMessages.ts` (read-only — do not modify)

## Constraints
- DO NOT modify: `useSSE.ts`, `useMessages.ts`, `server.ts`, `app.tsx`, any widget files
- Build: `cd /home/bjk/projects/sionapi/packages/web && bun run build`
- After fix: `cd /home/bjk/projects/sionapi && git add -A && git commit -m "fix(web): <description>"`

## Instructions
1. Read all four files above
2. Run the Playwright script to observe actual DOM transitions
3. Identify the remaining race condition
4. Fix it minimally — don't rewrite, don't over-engineer
5. Build and commit
