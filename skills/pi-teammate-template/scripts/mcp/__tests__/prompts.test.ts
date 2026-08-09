// Drives prompt handlers against a real on-disk DB rooted at a tmp HOME so we
// don't pollute ~/.pi. Each test spins up + tears down its own state.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createState, leaveActive } from '../state.ts'
import { HANDLERS, PROMPT_SPECS } from '../prompts.ts'
import type { NotificationSender } from '../channel-notifier.ts'

let homeTmp: string
let cwdTmp: string
let originalHome: string | undefined
let sender: NotificationSender & { calls: any[] }
let state: ReturnType<typeof createState>

/** Wrap a sync-throwing handler call into a promise so .rejects works. */
async function call(name: string, args: any) {
  return HANDLERS[name](state, args)
}

function makeSender() {
  const calls: any[] = []
  return Object.assign({ notification: (n: any) => { calls.push(n) } }, { calls })
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

test('PROMPT_SPECS exposes all 13 commands and HANDLERS covers each', () => {
  expect(PROMPT_SPECS).toHaveLength(13)
  for (const spec of PROMPT_SPECS) {
    expect(HANDLERS[spec.name]).toBeTypeOf('function')
  }
})

test('team-create makes a fresh DB and team-join joins it', async () => {
  const created = await HANDLERS['team-create'](state, { channel: 'qa' })
  expect(created).toMatch(/Created channel "qa"/)
  const joined = await HANDLERS['team-join'](state, { channel: 'qa', agent_name: 'tester' })
  expect(joined).toMatch(/Joined channel "qa" as "tester"/)
  expect(state.mamoru?.agentName).toBe('tester')
})

test('team-create with no name mints a claude-* channel', async () => {
  const out = await HANDLERS['team-create'](state, {})
  expect(out).toMatch(/Created channel "claude-/)
})

test('team-create on existing channel reports recreated', async () => {
  await HANDLERS['team-create'](state, { channel: 'dup' })
  const out = await HANDLERS['team-create'](state, { channel: 'dup' })
  expect(out).toMatch(/Recreated/)
})

test('team-join uses persona name when agent_name omitted', async () => {
  writeFileSync(join(cwdTmp, 'persona.yaml'), 'name: Persona\ndescription: x\n')
  await HANDLERS['team-create'](state, { channel: 'p' })
  const out = await HANDLERS['team-join'](state, { channel: 'p' })
  expect(out).toMatch(/as "Persona"/)
})

test('team-join refuses when already joined', async () => {
  await HANDLERS['team-create'](state, { channel: 'x' })
  await HANDLERS['team-join'](state, { channel: 'x', agent_name: 'a' })
  await expect(call('team-join', { channel: 'x', agent_name: 'b' })).rejects.toThrow(/Already joined/)
})

test('team-join auto-creates the channel when it does not exist yet', async () => {
  const out = await HANDLERS['team-join'](state, { channel: 'fresh', agent_name: 'lone' })
  expect(out).toMatch(/Joined channel "fresh"/)
})

test('team-leave broadcasts and clears state', async () => {
  await HANDLERS['team-create'](state, { channel: 'l' })
  await HANDLERS['team-join'](state, { channel: 'l', agent_name: 'leaver' })
  const out = await HANDLERS['team-leave'](state, {})
  expect(out).toMatch(/Left channel "l"/)
  expect(state.mamoru).toBeNull()
  expect(state.db).toBeNull()
})

test('team-status when not joined throws helpfully', async () => {
  await expect(call('team-status', {})).rejects.toThrow(/Not connected/)
})

test('team-status renders channel/agent/status lines after join', async () => {
  await HANDLERS['team-create'](state, { channel: 's' })
  await HANDLERS['team-join'](state, { channel: 's', agent_name: 'me' })
  const out = await HANDLERS['team-status'](state, {})
  expect(out).toMatch(/Channel: s/)
  expect(out).toMatch(/Agent: me/)
  expect(out).toMatch(/Outbound Tasks: 0/)
})

test('team-roster reports empty when alone', async () => {
  await HANDLERS['team-create'](state, { channel: 'r' })
  await HANDLERS['team-join'](state, { channel: 'r', agent_name: 'solo' })
  const out = await HANDLERS['team-roster'](state, {})
  expect(out).toMatch(/Roster is empty/)
})

test('team-history surfaces messages we sent', async () => {
  await HANDLERS['team-create'](state, { channel: 'h' })
  await HANDLERS['team-join'](state, { channel: 'h', agent_name: 'h1' })
  await HANDLERS['team-send'](state, { to: 'someone', message: 'hi there' })
  const out = await HANDLERS['team-history'](state, {})
  expect(out).toMatch(/hi there/)
})

test('team-send writes a message and returns its id', async () => {
  await HANDLERS['team-create'](state, { channel: 'snd' })
  await HANDLERS['team-join'](state, { channel: 'snd', agent_name: 's1' })
  const out = await HANDLERS['team-send'](state, { to: 'peer', message: 'yo' })
  expect(out).toMatch(/Message #\d+ sent to "peer"/)
})

test('task-list returns "No tasks found" on a fresh channel', async () => {
  await HANDLERS['team-create'](state, { channel: 't' })
  await HANDLERS['team-join'](state, { channel: 't', agent_name: 'u' })
  expect(await HANDLERS['task-list'](state, {})).toMatch(/No tasks found/)
})

test('task-cancel rejects unknown task_id', async () => {
  await HANDLERS['team-create'](state, { channel: 'tc' })
  await HANDLERS['team-join'](state, { channel: 'tc', agent_name: 'u' })
  await expect(call('task-cancel', { task_id: '999' })).rejects.toThrow(/No outbound task/)
})

test('task-history returns nothing for unknown task_id', async () => {
  await HANDLERS['team-create'](state, { channel: 'th' })
  await HANDLERS['team-join'](state, { channel: 'th', agent_name: 'u' })
  expect(await HANDLERS['task-history'](state, { task_id: '42' }))
    .toMatch(/No messages found for task #42/)
})

test('task-status reports "no active inbound" + "no outbound"', async () => {
  await HANDLERS['team-create'](state, { channel: 'ts' })
  await HANDLERS['team-join'](state, { channel: 'ts', agent_name: 'u' })
  const out = await HANDLERS['task-status'](state, {})
  expect(out).toMatch(/No active inbound task/)
  expect(out).toMatch(/No outbound tasks/)
})

test('persona-template writes a starter file in cwd', async () => {
  const out = await HANDLERS['persona-template'](state, {})
  expect(out).toMatch(/Created persona.yaml/)
})

test('persona-template refuses to overwrite', async () => {
  writeFileSync(join(cwdTmp, 'persona.yaml'), 'name: A\ndescription: B\n')
  await expect(call('persona-template', {})).rejects.toThrow(/already exists/)
})

test('team-join applies mamoruConfig overrides from state', async () => {
  const tuned = createState({ sender, cwd: cwdTmp, mamoruConfig: { pollIntervalMs: 250, staleHeartbeatMs: 10_000 } })
  try {
    await HANDLERS['team-create'](tuned, { channel: 'cfg' })
    await HANDLERS['team-join'](tuned, { channel: 'cfg', agent_name: 'c' })
    // @ts-expect-error — peek at private config for the test
    expect(tuned.mamoru!['config']).toMatchObject({ pollIntervalMs: 250, staleHeartbeatMs: 10_000 })
  } finally {
    leaveActive(tuned)
  }
})

test('team-remove-inactive reports zero on empty channel', async () => {
  await HANDLERS['team-create'](state, { channel: 'rm' })
  await HANDLERS['team-join'](state, { channel: 'rm', agent_name: 'u' })
  expect(await HANDLERS['team-remove-inactive'](state, {}))
    .toMatch(/No inactive sessions/)
})
