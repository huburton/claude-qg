// Pure logic of the channel: no I/O, no clock, no globals. Everything here is unit-tested (test/policy.test.ts).

export type Urgency = 'low' | 'normal' | 'high'
export type NtfyKind = 'immediate' | 'delayed' | 'reminder'

export type OutboxEvent = {
  id: number
  ts: string
  type: 'notify' | 'reply'
  title: string
  text: string
  project?: string
  task?: string
  choices?: string[]
  urgency: Urgency
  speak?: string
  chat_id?: string
  from?: string
  source: string
}

/** Per-message state kept next to the outbox: read / answered / phone push already sent. */
export type Mark = { seen?: string; answered?: string; ntfy?: string; ntfy_kind?: string }

export type PolicyConfig = {
  /** A `normal` message still unread after this many minutes is pushed to the phone. */
  normal_delay_min: number
  /** A question that was read but not answered after this many minutes gets one reminder. */
  question_reminder_min: number
  /** How often the server evaluates the policy, in seconds. */
  tick_s: number
}

export const DEFAULT_POLICY: PolicyConfig = { normal_delay_min: 10, question_reminder_min: 45, tick_s: 15 }

/** Messages older than this are never pushed (a server that was down for a day must not spam the phone). */
export const MAX_PUSH_AGE_MS = 24 * 3600e3

/**
 * Push decision at publish time.
 * Only `high` notifications go out right away. Replies never do: the user has just written, he is in front of the screen.
 */
export function ntfyOnPublish(ev: Pick<OutboxEvent, 'type' | 'urgency'>): NtfyKind | null {
  return ev.type === 'notify' && ev.urgency === 'high' ? 'immediate' : null
}

/**
 * Push decision evaluated on every tick for a message that has not been pushed yet.
 *  - low urgency and replies: never;
 *  - unread after `normal_delay_min`: one delayed push;
 *  - read, with choices, unanswered after `question_reminder_min`: one reminder.
 * At most one push per message: once `mark.ntfy` is set, the answer is always null.
 */
export function ntfyDue(ev: OutboxEvent, mark: Mark | undefined, nowMs: number, policy: PolicyConfig): NtfyKind | null {
  if (ev.type !== 'notify' || ev.urgency === 'low') return null
  const m = mark ?? {}
  const age = nowMs - Date.parse(ev.ts)
  if (m.ntfy || age > MAX_PUSH_AGE_MS) return null
  if (!m.seen) return age >= policy.normal_delay_min * 60e3 ? 'delayed' : null
  if (ev.choices?.length && !m.answered && nowMs - Date.parse(m.seen) >= policy.question_reminder_min * 60e3) return 'reminder'
  return null
}

/**
 * Which pending questions does a message from the user answer?
 * The ones whose title he quotes ("title"); otherwise every question he has already seen.
 */
export function answeredBy(text: string, outbox: OutboxEvent[], marks: Record<string, Mark>): number[] {
  const open = outbox.filter(e => e.type === 'notify' && e.choices?.length && !marks[e.id]?.answered)
  const cited = open.filter(e => text.includes(`"${e.title}"`))
  return (cited.length ? cited : open.filter(e => marks[e.id]?.seen)).map(e => e.id)
}

/** Validates the arguments of `notify` (MCP tool and POST /v1/notify). Returns an error string when invalid. */
export function parseNotify(a: any, source: string): Omit<OutboxEvent, 'id' | 'ts'> | string {
  const title = String(a?.title ?? '').trim()
  const text = String(a?.text ?? '').trim()
  if (!title || !text) return 'title and text are required'
  const choices = Array.isArray(a.choices)
    ? a.choices.map(String).map((c: string) => c.trim()).filter(Boolean).slice(0, 8)
    : undefined
  return {
    type: 'notify',
    title: title.slice(0, 120),
    text,
    project: a.project ? String(a.project) : undefined,
    task: a.task ? String(a.task) : undefined,
    choices: choices?.length ? choices : undefined,
    urgency: a.urgency === 'low' || a.urgency === 'normal' || a.urgency === 'high' ? a.urgency : 'normal',
    speak: a.speak ? String(a.speak) : undefined,
    source,
  }
}

/** Body of the ntfy publish request (JSON publishing: the topic is in the body). */
export function ntfyBody(ev: OutboxEvent, kind: NtfyKind | '', topic: string, click?: string): Record<string, unknown> {
  let message = ev.text.length > 1500 ? ev.text.slice(0, 1500) + '…' : ev.text
  if (ev.choices?.length) message += '\n\n' + ev.choices.map((c, i) => `${i + 1}. ${c}`).join('\n')
  const body: Record<string, unknown> = {
    topic,
    title: [kind === 'reminder' ? 'Reminder' : 'QG', ev.project, ev.title].filter(Boolean).join(' · '),
    message,
    markdown: true,
    priority: { low: 2, normal: 3, high: 4 }[ev.urgency] ?? 3,
    tags: [ev.choices?.length ? 'question' : 'robot'],
  }
  if (click) body.click = click.replace('{id}', String(ev.id))
  return body
}
