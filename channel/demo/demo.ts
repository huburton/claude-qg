#!/usr/bin/env bun
// Demo: runs the channel server locally with no Claude account and no phone.
//   - a fake ntfy server (the "phone") records every push it receives;
//   - a fake Claude Code speaks MCP over the server's stdio and answers channel messages;
//   - this script plays the clients (a script calling /v1/notify, the panel reading the SSE stream and sending read receipts).
// The policy delays are shrunk (10 min -> 3 s, 45 min -> 6 s) so the whole story fits in about 12 seconds.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KEY = 'demo-key'
const PORT = Number(process.env.QG_DEMO_PORT ?? 47098)
const NTFY_PORT = PORT + 1
const BASE = `http://127.0.0.1:${PORT}`
const t0 = Date.now()
const c = (n: number, s: string) => (process.stdout.isTTY || process.env.FORCE_COLOR ? `\x1b[${n}m${s}\x1b[0m` : s)
const stamp = () => c(90, `[+${((Date.now() - t0) / 1000).toFixed(1).padStart(4)}s]`)
const say = (tag: string, color: number, msg: string) => console.log(`${stamp()} ${c(color, tag.padEnd(7))} ${msg}`)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---- fake ntfy: the phone
const pushes: { title: string; priority: number; message: string; at: number }[] = []
const ntfy = Bun.serve({
  port: NTFY_PORT, hostname: '127.0.0.1',
  async fetch(req) {
    const b: any = await req.json()
    pushes.push({ title: b.title, priority: b.priority, message: b.message, at: Date.now() })
    say('PHONE', 35, `push p${b.priority} ${c(1, b.title)}`)
    return Response.json({ ok: true })
  },
})

// ---- the channel server, with a fake Claude Code on its stdio
const state = mkdtempSync(join(tmpdir(), 'qg-demo-'))
const server = spawn('bun', [join(import.meta.dir, '../src/channel.ts')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: {
    ...process.env,
    QG_CHANNEL_KEY: KEY, QG_CHANNEL_PORT: String(PORT), QG_CHANNEL_STATE: state,
    QG_NTFY_URL: `http://127.0.0.1:${NTFY_PORT}`, QG_NTFY_TOPIC: 'demo-topic',
    QG_NORMAL_DELAY_MIN: '0.05', QG_QUESTION_REMINDER_MIN: '0.1', QG_POLICY_TICK_S: '0.5',
  },
})
const rpc = (o: unknown) => server.stdin.write(JSON.stringify(o) + '\n')
let rpcId = 1
const callTool = (name: string, args: unknown) =>
  rpc({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } } })
rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
let buf = ''
server.stdout.on('data', d => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    const m = JSON.parse(line)
    if (m.method === 'notifications/claude/channel') {
      const { content, meta } = m.params
      say('QG', 33, `received from ${meta.from} (trust=${meta.trust}): "${content}"`)
      callTool('reply', { chat_id: meta.chat_id, text: `(fake QG) Got it: ${content}` })
    }
  }
})

const http = async (path: string, body?: unknown) => {
  const r = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return r.json() as Promise<any>
}
for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/health', { headers: { Authorization: `Bearer ${KEY}` } }); break } catch { await sleep(100) } }

// ---- the panel: reads the SSE stream
const ids: Record<string, number> = {}
const sse = await fetch(`${BASE}/v1/events`, { headers: { Authorization: `Bearer ${KEY}` } })
;(async () => {
  const dec = new TextDecoder(); let acc = ''
  for await (const chunk of sse.body as any) {
    acc += dec.decode(chunk)
    let i
    while ((i = acc.indexOf('\n\n')) >= 0) {
      const frame = acc.slice(0, i); acc = acc.slice(i + 2)
      const data = frame.split('\n').find(l => l.startsWith('data: '))
      if (!data) continue
      const ev = JSON.parse(data.slice(6))
      const tag = ev.urgency === 'high' ? c(31, ev.urgency) : ev.urgency === 'low' ? c(90, ev.urgency) : ev.urgency
      say('PANEL', 36, `${ev.type} [${tag}] ${c(1, ev.title)}${ev.choices ? '  choices: ' + ev.choices.join(' / ') : ''}`)
    }
  }
})()

console.log(c(1, 'QG channel demo') + c(90, '  (policy delays shrunk: 10 min -> 3 s, 45 min -> 6 s)\n'))
const post = async (key: string, a: any) => { ids[key] = (await http('/v1/notify', { from: 'demo-script', ...a })).id }

say('SCRIPT', 32, 'low: routine info (panel only, never the phone)')
await post('low', { title: 'Nightly backup finished', text: '12 GB, 41 s.', urgency: 'low', project: 'infra' })
await sleep(600)
say('SCRIPT', 32, 'high: blocking failure (phone right away)')
await post('high', { title: 'Deploy failed', text: 'Migration 0042 timed out.', urgency: 'high', project: 'billing', task: 'deploy-fix' })
await sleep(600)
say('USER', 34, 'on the phone, talks to the QG (trust=user) and waits for the answer')
const r = await http('/message', { text: 'status of the website project?', from: 'phone', wait: true })
say('USER', 34, `got: ${r.reply}`)
await sleep(300)
say('SCRIPT', 32, 'normal, which the user reads on screen within the delay')
await post('read', { title: 'Report ready', text: 'Worker finished the audit.', project: 'website', task: 'audit' })
await sleep(300)
say('PANEL', 36, 'read receipt for "Report ready" (page visible)')
await http('/v1/seen', { ids: [ids.read] })
say('SCRIPT', 32, 'normal, left unread (delayed phone push)')
await post('unread', { title: 'Weekly summary', text: 'Nothing urgent.', project: 'infra' })
say('SCRIPT', 32, 'a question: the user reads it but never answers (one reminder)')
await post('q', { title: 'Merge the branch?', text: 'Tests are green.', choices: ['Merge', 'Wait', 'Show diff'], project: 'website' })
await sleep(300)
say('PANEL', 36, 'read receipt for "Merge the branch?" (and no answer ever comes)')
await http('/v1/seen', { ids: [ids.q] })

await sleep(8500)
const box = (await http('/v1/outbox?since=0')).events as any[]
console.log('\n' + c(1, 'Result') + c(90, '  (what the policy decided, read back from the outbox)'))
for (const e of box) {
  const when = e.ntfy_at ? `phone push at +${((Date.parse(e.ntfy_at) - t0) / 1000).toFixed(1)}s` : 'no phone push'
  console.log(`  ${e.title.padEnd(26)} ${String(e.urgency).padEnd(7)} ${e.seen_at ? 'read  ' : 'unread'}  ${when}${e.ntfy_at && e.choices ? ' (reminder)' : ''}`)
}
console.log(c(90, `\n  ${pushes.length} push(es) received by the fake phone; the channel never sends more than one per message.`))

server.kill(); ntfy.stop(true); rmSync(state, { recursive: true, force: true })
process.exit(0)
