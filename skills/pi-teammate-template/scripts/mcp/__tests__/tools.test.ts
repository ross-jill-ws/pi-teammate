import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createState, leaveActive } from '../state.ts'
import { HANDLERS as PROMPT_HANDLERS } from '../prompts.ts'
import { TOOL_SPECS, HANDLERS as TOOL_HANDLERS } from '../tools.ts'
import { getTeammateDir } from '../../mamoru/paths.ts'
import type { NotificationSender } from '../channel-notifier.ts'

let homeTmp: string
let cwdTmp: string
let originalHome: string | undefined
let sender: NotificationSender & { calls: any[] }
let state: ReturnType<typeof createState>

function makeSender() {
  const calls: any[] = []
  return Object.assign({ notification: (n: any) => { calls.push(n) } }, { calls })
}

async function joinAs(channel: string, agent: string) {
  await PROMPT_HANDLERS['team-create'](state, { channel })
  await PROMPT_HANDLERS['team-join'](state, { channel, agent_name: agent })
}

/** Wrap a sync-throwing handler so `.rejects.toThrow()` works. */
async function callTool(name: string, args: any) {
  return TOOL_HANDLERS[name](state, args)
}

beforeEach(() => {
  originalHome = process.env.HOME
  homeTmp = mkdtempSync(join(tmpdir(), 'mcp-home-'))
  cwdTmp = mkdtempSync(join(tmpdir(), 'mcp-cwd-'))
  process.env.HOME = homeTmp
  sender = makeSender()
  state = createState({ sender, cwd: cwdTmp })
})

afterEach(() => {
  try { leaveActive(state) } catch {}
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  rmSync(homeTmp, { recursive: true, force: true })
  rmSync(cwdTmp, { recursive: true, force: true })
})

test('TOOL_SPECS exposes both tools', () => {
  const names = TOOL_SPECS.map(t => t.name).sort()
  expect(names).toEqual(['get-team-roster', 'send-message-to-teammate'])
})

test('send-message-to-teammate pre-join throws', async () => {
  await expect(callTool('send-message-to-teammate', { event: 'broadcast', content: 'hi' }))
    .rejects.toThrow(/Not joined/)
})

test('get-team-roster pre-join throws', async () => {
  await expect(callTool('get-team-roster', {})).rejects.toThrow(/Not joined/)
})

test('send-message-to-teammate broadcast writes and returns id', async () => {
  await joinAs('tch', 'me')
  const out = await callTool('send-message-to-teammate', { event: 'broadcast', content: 'team hi' })
  expect(out).toMatch(/Message #\d+ \(broadcast\) sent to \(broadcast\)\./)
})

test('send-message-to-teammate task_req requires detail', async () => {
  await joinAs('tch', 'me')
  // Fabricate a teammate in roster so the task_req preconditions reach detail check.
  state.mamoru!.getRoster().update({ session_id: 'peer', agent_name: 'peer', description: '', status: 'available', last_heartbeat: Date.now() })
  await expect(callTool('send-message-to-teammate', { event: 'task_req', to: 'peer', content: 'do' }))
    .rejects.toThrow(/detail/i)
})

test('send-message-to-teammate requires detail to be absolute', async () => {
  await joinAs('tch', 'me')
  await expect(callTool('send-message-to-teammate', { event: 'info_only', content: 'x', detail: 'rel/path.md' }))
    .rejects.toThrow(/absolute/i)
})

test('send-message-to-teammate requires detail file to exist', async () => {
  await joinAs('tch', 'me')
  await expect(callTool('send-message-to-teammate', { event: 'info_only', content: 'x', detail: '/tmp/definitely-not-here-xyzzy.md' }))
    .rejects.toThrow(/does not exist/)
})

test('send-message-to-teammate requires detail under sender teammate dir', async () => {
  await joinAs('tch', 'me')
  const stray = join(cwdTmp, 'stray.md')
  writeFileSync(stray, '# stray')
  await expect(callTool('send-message-to-teammate', { event: 'info_only', content: 'x', detail: stray }))
    .rejects.toThrow(/teammate dir/)
})

test('send-message-to-teammate accepts detail under sender teammate dir', async () => {
  await joinAs('tch', 'me')
  state.mamoru!.getRoster().update({ session_id: 'peer', agent_name: 'peer', description: '', status: 'available', last_heartbeat: Date.now() })
  const dir = getTeammateDir('tch', state.sessionId!)
  const file = join(dir, 'detail.md')
  writeFileSync(file, '# detail')
  const out = await callTool('send-message-to-teammate', { event: 'task_req', to: 'peer', content: 'go', detail: file })
  expect(out).toMatch(/Task #\d+ sent to peer/)
})

test('send-message-to-teammate reserved event surfaces clear error', async () => {
  await joinAs('tch', 'me')
  await expect(callTool('send-message-to-teammate', { event: 'task_ack', content: 'hi' }))
    .rejects.toThrow(/reserved/i)
})

test('get-team-roster solo → only "Teammates: none"', async () => {
  await joinAs('tch', 'solo')
  const out = await TOOL_HANDLERS['get-team-roster'](state, {}) as string
  expect(out).toMatch(/Channel: tch/)
  expect(out).toMatch(/Your session:/)
  expect(out).toMatch(/Teammates: none/)
})

test('get-team-roster annotates busy peer with task-from-you', async () => {
  await joinAs('tch', 'me')
  state.mamoru!.getRoster().update({ session_id: 'peer', agent_name: 'peer', description: 'p', status: 'available', last_heartbeat: Date.now() })
  const dir = getTeammateDir('tch', state.sessionId!)
  const file = join(dir, 'go.md')
  writeFileSync(file, '# go')
  await callTool('send-message-to-teammate', { event: 'task_req', to: 'peer', content: 'go', detail: file })
  // Flip peer to busy in the roster to match what their side would do on ack.
  state.mamoru!.getRoster().update({ session_id: 'peer', agent_name: 'peer', description: 'p', status: 'busy', last_heartbeat: Date.now() })
  const out = await TOOL_HANDLERS['get-team-roster'](state, {}) as string
  expect(out).toMatch(/peer.*busy \(task #\d+ from you/)
})
