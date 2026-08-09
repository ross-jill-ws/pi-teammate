// Server `instructions` string returned from MCP initialize. Teaches the
// model how to interpret incoming channel notifications and when to reply.
// Persona (if loaded) is appended on top so user-authored framing comes last.

import type { PersonaConfig } from './persona.ts'

const BASE = [
  'mcp-teammate runs a peer-to-peer messaging channel between Claude Code',
  'agents. Here is how to participate.',
  '',
  'Receiving:',
  '- Channel events are pushed to you via `notifications/claude/channel`.',
  '  Each notification has `content` (a short rendered summary) and `meta`',
  '  with fields like `event`, `task_id`, `from`.',
  '- On `task_req` (a peer asking you to do work): MAMORU has already ack\'d',
  '  on your behalf and marked you busy. Do the work, then reply with',
  '  `task_done` / `task_fail` / `task_update` / `task_clarify` via the',
  '  `send-message-to-teammate` tool. You may omit `to`/`task_id` — they',
  '  default to the active inbound task.',
  '- On `task_ack`, `task_reject`, `task_cancel_ack`: informational only —',
  '  MAMORU handles bookkeeping, no action required from you.',
  '- On `task_done` / `task_fail` for an outbound task you sent: use it as',
  '  the answer to whatever originally prompted you to delegate.',
  '- On `task_clarify` / `task_clarify_res` / `task_update`: respond if the',
  '  message calls for it.',
  '- On `broadcast` / `info_only`: usually informational. Reply only if the',
  '  content explicitly asks for one.',
  '',
  'Sending:',
  '- Always call `get-team-roster` before every `send-message-to-teammate`',
  '  — the roster can change between turns.',
  '- `content` must be ≤ 20 words. Everything longer goes into a markdown',
  '  detail file whose absolute path you pass as `detail`.',
  '- `detail` is required for `task_req`, recommended for `task_done` and',
  '  `task_fail`. The file must live under',
  '  ~/.pi/pi-teammate/<channel>/<your session_id>/ and must exist before',
  '  the call (write it first with your file tools).',
  '- Reserved events (ping, pong, task_ack, task_reject, task_cancel_ack)',
  '  are sent by MAMORU automatically — you cannot send them.',
  '',
  'Slash commands (prompts) are available under /mcp__mcp-teammate__* for',
  'joining channels, inspecting rosters, and managing tasks manually.',
].join('\n')

export function buildInstructions(persona: PersonaConfig | null): string {
  if (!persona) return BASE
  const parts: string[] = []
  if (persona.systemPrompt) parts.push(persona.systemPrompt)
  if (persona.description) parts.push(`Persona: ${persona.name} — ${persona.description}`)
  if (parts.length === 0) return BASE
  return `${parts.join('\n\n')}\n\n---\n\n${BASE}`
}
