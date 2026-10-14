import { describe, expect, test } from 'bun:test'
import { answeredBy, DEFAULT_POLICY, MAX_PUSH_AGE_MS, ntfyBody, ntfyDue, ntfyOnPublish, parseNotify } from '../src/policy.ts'
import type { Mark, OutboxEvent } from '../src/policy.ts'

const T0 = Date.parse('2026-01-01T12:00:00Z')
const MIN = 60e3
const ev = (o: Partial<OutboxEvent> = {}): OutboxEvent => ({
  id: 1, ts: new Date(T0).toISOString(), type: 'notify', title: 'T', text: 'x', urgency: 'normal', source: 'qg', ...o,
})
const at = (min: number) => T0 + min * MIN

describe('ntfyOnPublish', () => {
  test('high notify is pushed right away', () => expect(ntfyOnPublish(ev({ urgency: 'high' }))).toBe('immediate'))
  test('normal and low wait', () => {
    expect(ntfyOnPublish(ev({ urgency: 'normal' }))).toBeNull()
    expect(ntfyOnPublish(ev({ urgency: 'low' }))).toBeNull()
  })
  test('a reply is never pushed, whatever its urgency', () => expect(ntfyOnPublish(ev({ type: 'reply', urgency: 'high' }))).toBeNull())
})

describe('ntfyDue', () => {
  const P = DEFAULT_POLICY
  test('low urgency: never', () => {
    expect(ntfyDue(ev({ urgency: 'low' }), undefined, at(600), P)).toBeNull()
    expect(ntfyDue(ev({ urgency: 'low', choices: ['a', 'b'] }), { seen: new Date(T0).toISOString() }, at(600), P)).toBeNull()
  })
  test('reply: never', () => expect(ntfyDue(ev({ type: 'reply' }), undefined, at(600), P)).toBeNull())
  test('unread normal: nothing before the delay, one push after', () => {
    expect(ntfyDue(ev(), undefined, at(9.9), P)).toBeNull()
    expect(ntfyDue(ev(), undefined, at(10), P)).toBe('delayed')
  })
  test('normal read before the delay: no push at all', () => {
    const m: Mark = { seen: new Date(at(3)).toISOString() }
    expect(ntfyDue(ev(), m, at(600), P)).toBeNull()
  })
  test('question read but unanswered: reminder 45 min after it was READ (not after it was sent)', () => {
    const m: Mark = { seen: new Date(at(20)).toISOString() }
    const q = ev({ choices: ['yes', 'no'] })
    expect(ntfyDue(q, m, at(64), P)).toBeNull()
    expect(ntfyDue(q, m, at(65), P)).toBe('reminder')
  })
  test('answered question: no reminder', () => {
    const m: Mark = { seen: new Date(at(1)).toISOString(), answered: new Date(at(2)).toISOString() }
    expect(ntfyDue(ev({ choices: ['yes', 'no'] }), m, at(600), P)).toBeNull()
  })
  test('at most one push per message', () => {
    expect(ntfyDue(ev(), { ntfy: new Date(at(10)).toISOString() }, at(600), P)).toBeNull()
    const m: Mark = { seen: new Date(at(1)).toISOString(), ntfy: new Date(at(2)).toISOString() }
    expect(ntfyDue(ev({ choices: ['a'] }), m, at(600), P)).toBeNull()
  })
  test('old messages are not pushed after an outage', () => {
    expect(ntfyDue(ev(), undefined, T0 + MAX_PUSH_AGE_MS + 1, P)).toBeNull()
  })
  test('delays come from the configuration', () => {
    expect(ntfyDue(ev(), undefined, at(1), { ...P, normal_delay_min: 1 })).toBe('delayed')
  })
})

describe('answeredBy', () => {
  const q1 = ev({ id: 1, title: 'Deploy now?', choices: ['yes', 'no'] })
  const q2 = ev({ id: 2, title: 'Rename branch?', choices: ['yes', 'no'] })
  const q3 = ev({ id: 3, title: 'Unread one', choices: ['yes', 'no'] })
  const info = ev({ id: 4, title: 'Just info' })
  const outbox = [q1, q2, q3, info]
  const seen = (id: number): Record<string, Mark> => ({ [id]: { seen: 'x' } })

  test('quoting a title answers that question only', () => {
    const marks = { ...seen(1), ...seen(2) }
    expect(answeredBy('Answer to "Rename branch?": yes', outbox, marks)).toEqual([2])
  })
  test('a free-text message answers every question already seen', () => {
    const marks = { ...seen(1), ...seen(2) }
    expect(answeredBy('ok go ahead', outbox, marks)).toEqual([1, 2])
  })
  test('unread questions and plain notifications are left alone', () => {
    expect(answeredBy('ok', outbox, {})).toEqual([])
  })
  test('already answered questions are skipped', () => {
    expect(answeredBy('ok', outbox, { 1: { seen: 'x', answered: 'y' } })).toEqual([])
  })
})

describe('parseNotify', () => {
  test('title and text are required', () => {
    expect(typeof parseNotify({ title: '', text: 'x' }, 'qg')).toBe('string')
    expect(typeof parseNotify({ title: 'x' }, 'qg')).toBe('string')
    expect(typeof parseNotify(undefined, 'qg')).toBe('string')
  })
  test('defaults to normal urgency and ignores unknown values', () => {
    expect((parseNotify({ title: 'a', text: 'b' }, 'qg') as OutboxEvent).urgency).toBe('normal')
    expect((parseNotify({ title: 'a', text: 'b', urgency: 'critical' }, 'qg') as OutboxEvent).urgency).toBe('normal')
    expect((parseNotify({ title: 'a', text: 'b', urgency: 'high' }, 'qg') as OutboxEvent).urgency).toBe('high')
  })
  test('trims choices, drops blanks, keeps at most 8', () => {
    const r = parseNotify({ title: 'a', text: 'b', choices: [' yes ', '', 'no', ...'abcdefgh'] }, 'qg') as OutboxEvent
    expect(r.choices?.length).toBe(8)
    expect(r.choices?.slice(0, 2)).toEqual(['yes', 'no'])
  })
  test('title is capped at 120 characters', () => {
    expect((parseNotify({ title: 'x'.repeat(300), text: 'b' }, 'qg') as OutboxEvent).title.length).toBe(120)
  })
})

describe('ntfyBody', () => {
  test('priority follows urgency, choices are numbered, click template gets the id', () => {
    const b = ntfyBody(ev({ id: 42, urgency: 'high', project: 'site', title: 'Deploy', choices: ['go', 'wait'] }), 'immediate', 'topic', 'https://app.example/#/m/{id}')
    expect(b.priority).toBe(4)
    expect(b.title).toBe('QG · site · Deploy')
    expect(String(b.message)).toContain('1. go\n2. wait')
    expect(b.click).toBe('https://app.example/#/m/42')
    expect(b.tags).toEqual(['question'])
  })
  test('reminder is labelled, long text is truncated', () => {
    const b = ntfyBody(ev({ text: 'y'.repeat(2000) }), 'reminder', 'topic')
    expect(String(b.title).startsWith('Reminder')).toBe(true)
    expect(String(b.message).length).toBe(1501)
    expect(b.click).toBeUndefined()
  })
})
