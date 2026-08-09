#!/usr/bin/env bun
// Speak a short line with this teammate's ElevenLabs voice. Wired into Claude
// Code SessionStart/Stop hooks by the pi-teammate-template skill.
//
// Reads persona.yaml from cwd (the teammate folder — hooks run there) for the
// voiceId. Mirrors extensions/tts.ts conventions: same default voice, model,
// and MP3 cache dir, so pi and Claude Code teammates share cached audio.
//
// Always exits 0. Missing API key, voiceId "none", or any synth/playback
// failure just means silence — a voice hook must never break the session.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { loadPersona } from './mcp/persona.ts'

const ELEVENLABS_TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech'
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM' // Rachel
const MODEL_ID = 'eleven_v3'
const OUTPUT_FORMAT = 'mp3_44100_128'
const CACHE_DIR = join(homedir(), '.pi', 'pi-teammate', 'audios')
const VOICE_SETTINGS = {
  stability: 0.4,
  similarity_boost: 0.75,
  style: 0.06,
  use_speaker_boost: true,
}

function resolveVoiceId(): string | null {
  try {
    const persona = loadPersona(process.cwd())
    const raw = (persona as any)?.voiceId
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (trimmed.toLowerCase() === 'none') return null // hard-disabled
      if (trimmed !== '') return trimmed
    }
  } catch {
    // unreadable persona → fall through to the default voice
  }
  return DEFAULT_VOICE_ID
}

async function getAudioFile(text: string, voiceId: string, apiKey: string): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true })
  const key = createHash('md5').update(`${voiceId}:${text}`).digest('hex')
  const cachePath = join(CACHE_DIR, `${key}.mp3`)
  if (existsSync(cachePath)) return cachePath

  const url = `${ELEVENLABS_TTS_URL}/${voiceId}?output_format=${OUTPUT_FORMAT}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
    body: JSON.stringify({ text, model_id: MODEL_ID, voice_settings: VOICE_SETTINGS }),
  })
  if (!response.ok) {
    throw new Error(`ElevenLabs API ${response.status}: ${await response.text().catch(() => '')}`)
  }
  writeFileSync(cachePath, Buffer.from(await response.arrayBuffer()))
  return cachePath
}

function playAudio(filePath: string): Promise<void> {
  return new Promise(resolve => {
    const players = [
      { cmd: 'mpv', args: ['--no-video', '--really-quiet', filePath] },
      { cmd: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', filePath] },
      { cmd: 'afplay', args: [filePath] },
    ]
    function tryNext(index: number): void {
      if (index >= players.length) return resolve()
      const { cmd, args } = players[index]!
      const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'] })
      child.on('error', () => tryNext(index + 1))
      child.on('close', code => (code === 0 || code === null ? resolve() : tryNext(index + 1)))
    }
    tryNext(0)
  })
}

const text = process.argv.slice(2).join(' ').trim()
const apiKey = process.env.ELEVENLABS_API_KEY
const voiceId = resolveVoiceId()

if (text && apiKey && voiceId) {
  try {
    await playAudio(await getAudioFile(text, voiceId, apiKey))
  } catch (err: any) {
    console.error(`[tts-say] ${err.message}`)
  }
}
process.exit(0)
