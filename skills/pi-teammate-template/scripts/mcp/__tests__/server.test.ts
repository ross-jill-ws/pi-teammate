import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'

import { getDbPath, getTeammateDir } from '../../mamoru/paths.ts'
import { openChannelDb } from '../../mamoru/schema.ts'
import { createPayload } from '../../mamoru/types.ts'
import { registerAgent, sendMessage, sendTaskReq } from '../../mamoru/db.ts'
import { PROMPT_SPECS } from '../prompts.ts'
import { TOOL_SPECS } from '../tools.ts'

const BIN_PATH = resolve(import.meta.dir, '../../teammate-mcp.ts')

type JsonRpcMessage = {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: any
  result?: any
  error?: { code: number; message: string; data?: unknown }
}

class McpHarness {
  readonly notifications: JsonRpcMessage[] = []
  readonly stderr: string[] = []
  instructions = ''

  private child: ChildProcessWithoutNullStreams
  private readBuffer = new ReadBuffer()
  private nextId = 1
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()

  constructor(cwd: string, home: string, envOverrides: Record<string, string> = {}) {
    this.child = spawn('bun', [BIN_PATH], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        MCP_TEAMMATE_POLL_INTERVAL_MS: '50',
        MCP_TEAMMATE_STALE_HEARTBEAT_MS: '500',
        ...envOverrides,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.child.stdout.on('data', chunk => {
      this.readBuffer.append(chunk)
      for (;;) {
        const message = this.readBuffer.readMessage() as JsonRpcMessage | null
        if (!message) break
        this.handleMessage(message)
      }
    })

    this.child.stderr.on('data', chunk => {
      this.stderr.push(String(chunk))
    })

    this.child.on('exit', code => {
      const err = new Error(`mcp-teammate exited early with code ${code}. stderr:\n${this.stderr.join('')}`)
      for (const { reject } of this.pending.values()) reject(err)
      this.pending.clear()
    })
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new Error(message.error.message))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (message.method) this.notifications.push(message)
  }

  private send(message: JsonRpcMessage): void {
    this.child.stdin.write(serializeMessage(message as any))
  }

  async start(): Promise<void> {
    const init = await this.request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mcp-teammate-test', version: '1.0.0' },
    })
    this.instructions = init.instructions ?? ''
    this.notify('notifications/initialized')
  }

  request(method: string, params: any = {}): Promise<any> {
    const id = this.nextId++
    this.send({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
  }

  notify(method: string, params?: any): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  async close(): Promise<void> {
    this.child.stdin.end()
    const deadline = Date.now() + 2000
    while (this.child.exitCode === null && Date.now() < deadline) {
      await Bun.sleep(25)
    }
    if (this.child.exitCode === null) this.child.kill('SIGTERM')
  }
}

let homeTmp: string
let cwdTmp: string
let originalHome: string | undefined
let harness: McpHarness | null = null

async function restartHarness(envOverrides: Record<string, string> = {}) {
  if (harness) await harness.close()
  harness = new McpHarness(cwdTmp, homeTmp, envOverrides)
  await harness.start()
}

function promptText(result: any): string {
  return result.messages[0].content.text
}

function toolText(result: any): string {
  return result.content[0].text
}

async function waitForNotification(
  notifications: JsonRpcMessage[],
  event: string,
  timeoutMs = 3000,
): Promise<JsonRpcMessage> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = notifications.find(n => n.method === 'notifications/claude/channel' && n.params?.meta?.event === event)
    if (found) return found
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for channel notification event=${event}. Saw: ${notifications.map(n => n.params?.meta?.event ?? n.method ?? '?').join(', ')}`)
    }
    await Bun.sleep(25)
  }
}

async function waitForText(
  read: () => Promise<string>,
  needle: string,
  timeoutMs = 3000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    last = await read()
    if (last.includes(needle)) return last
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for text containing ${JSON.stringify(needle)}. Last value:\n${last}`)
    }
    await Bun.sleep(25)
  }
}

beforeEach(async () => {
  originalHome = process.env.HOME
  homeTmp = mkdtempSync(join(tmpdir(), 'mcp-server-home-'))
  cwdTmp = mkdtempSync(join(tmpdir(), 'mcp-server-cwd-'))
  process.env.HOME = homeTmp
  writeFileSync(
    join(cwdTmp, 'persona.yaml'),
    [
      'name: Channel Tester',
      'description: Exercises Claude Code teammate flows',
      'systemPrompt: Speak in short checklists.',
      '',
    ].join('\n'),
  )

  await restartHarness()
})

afterEach(async () => {
  if (harness) {
    await harness.close()
    harness = null
  }
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  rmSync(homeTmp, { recursive: true, force: true })
  rmSync(cwdTmp, { recursive: true, force: true })
})

describe('teammate MCP server', () => {
  test('initialize exposes startup persona, prompts, and tools', async () => {
    expect(harness!.instructions).toContain('Speak in short checklists.')
    expect(harness!.instructions).toContain('Persona: Channel Tester — Exercises Claude Code teammate flows')

    const prompts = await harness!.request('prompts/list')
    expect(prompts.prompts.map((p: any) => p.name).sort()).toEqual(PROMPT_SPECS.map(p => p.name).sort())

    const tools = await harness!.request('tools/list')
    expect(tools.tools.map((t: any) => t.name).sort()).toEqual(TOOL_SPECS.map(t => t.name).sort())
  })

  test('optional env auto-join joins immediately after initialize', async () => {
    await restartHarness({
      MCP_TEAMMATE_AUTOJOIN_CHANNEL: 'autojoin-test',
      MCP_TEAMMATE_AUTOJOIN_AGENT_NAME: 'AutoJoiner',
    })

    const rosterText = await waitForText(
      async () => toolText(await harness!.request('tools/call', { name: 'get-team-roster', arguments: {} })),
      'Channel: autojoin-test',
      5000,
    )

    expect(rosterText).toContain('Your session:')
    expect(rosterText).toContain('(AutoJoiner, available)')
  })

  test('Claude-style stdio flow receives channel notifications and replies through MCP tools', async () => {
    const channel = 'server-e2e'

    expect(promptText(await harness!.request('prompts/get', { name: 'team-create', arguments: { channel } })))
      .toContain(`Created channel "${channel}"`)

    const joinText = promptText(await harness!.request('prompts/get', { name: 'team-join', arguments: { channel } }))
    expect(joinText).toContain(`Joined channel "${channel}" as "Channel Tester"`)
    const sessionId = joinText.match(/\((claude-[^)]+)\)$/)?.[1]
    expect(sessionId).toBeTruthy()

    const db = openChannelDb(getDbPath(channel))
    try {
      registerAgent(db, {
        session_id: 'peer-1',
        agent_name: 'Peer One',
        description: 'Helpful pi teammate',
        provider: null,
        model: null,
        cwd: null,
      })

      sendMessage(db, {
        from_agent: 'peer-1',
        to_agent: null,
        channel,
        task_id: null,
        ref_message_id: null,
        payload: JSON.stringify(createPayload('broadcast', 'Peer One has joined the channel', {
          intent: 'agent_join',
        })),
      })

      const joinNote = await waitForNotification(harness!.notifications, 'agent_join')
      expect(joinNote.params.content).toContain('joined the channel')

      const rosterText = await waitForText(
        async () => toolText(await harness!.request('tools/call', { name: 'get-team-roster', arguments: {} })),
        'Peer One (peer-1)',
      )
      expect(rosterText).toContain('available')

      const taskId = sendTaskReq(db, {
        from_agent: 'peer-1',
        to_agent: sessionId!,
        channel,
        payload: JSON.stringify(createPayload('task_req', 'review the latest changes')),
      })

      const taskNote = await waitForNotification(harness!.notifications, 'task_req')
      expect(taskNote.params.content).toContain('review the latest changes')
      expect(taskNote.params.meta.task_id).toBe(String(taskId))

      const busyStatus = promptText(await harness!.request('prompts/get', { name: 'team-status', arguments: {} }))
      expect(busyStatus).toContain('Status: busy')
      expect(busyStatus).toContain(`Active Task: #${taskId} from peer-1`)

      const ackRows = db.prepare(`
        SELECT payload FROM messages
        WHERE from_agent = ? AND to_agent = ? AND task_id = ?
        ORDER BY message_id ASC
      `).all(sessionId!, 'peer-1', taskId) as { payload: string }[]
      expect(ackRows.some(row => JSON.parse(row.payload).event === 'task_ack')).toBe(true)

      const detailFile = join(getTeammateDir(channel, sessionId!), 'task-result.md')
      writeFileSync(detailFile, '# done\n\nLooks good.')

      const doneText = toolText(await harness!.request('tools/call', {
        name: 'send-message-to-teammate',
        arguments: {
          event: 'task_done',
          content: 'review complete',
          detail: detailFile,
        },
      }))
      expect(doneText).toContain('(task_done) sent to peer-1')

      const doneRows = db.prepare(`
        SELECT to_agent, task_id, payload FROM messages
        WHERE from_agent = ?
        ORDER BY message_id ASC
      `).all(sessionId!) as { to_agent: string | null; task_id: number | null; payload: string }[]
      const doneRow = doneRows.find(row => JSON.parse(row.payload).event === 'task_done')
      expect(doneRow).toBeTruthy()
      expect(doneRow?.to_agent).toBe('peer-1')
      expect(doneRow?.task_id).toBe(taskId)

      const availableStatus = promptText(await harness!.request('prompts/get', { name: 'team-status', arguments: {} }))
      expect(availableStatus).toContain('Status: available')
      expect(availableStatus).toContain('Active Task: none')
    } finally {
      db.close()
    }
  })
})
