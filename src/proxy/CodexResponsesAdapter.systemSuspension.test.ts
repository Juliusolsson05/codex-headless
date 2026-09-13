import { Buffer } from 'node:buffer'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRecordedAdapterHarness } from './testing/adapterHarness.js'

// Sleep-severed streams (agent-code#963).
//
// When the machine sleeps mid-turn, the stream's connection dies with it. Two
// things went wrong on wake:
//   1. The watchdog's first post-wake tick found every flow "stale" and released
//      it as an anonymous timeout, without publishing `idle` — a turn stopped
//      mid tool-call stayed in `tool-input` in the host UI, and nothing could say
//      the turn was interrupted by sleep.
//   2. There was no way for the host, which knows the machine slept, to close
//      the flows that died with it.
// `sealFlowsSilentSince` is that way; the watchdog now defers a tick that arrives
// hours late so the host's seal can act first.
//
// Times are from a real recording in the agent-code decomposition
// (docs/decomposition/agent-working-time.md, case A): clamshell sleep
// 2026-08-31 23:43:59 → wake 2026-09-01 08:01:40 PDT. Frame content is synthetic.

const PDT = (local: string): number => Date.parse(`${local}-07:00`)
const PROMPT_AT = PDT('2026-08-31T20:57:09')
const SLEEP_AT = PDT('2026-08-31T23:43:59')
const WAKE_AT = PDT('2026-09-01T08:01:40')
const UPSTREAM = 'https://chatgpt.com/backend-api/codex/responses'

type Frame = Record<string, unknown>

function mount() {
  const { proxy, semantic, adapter } = createRecordedAdapterHarness()
  const events: Array<Record<string, unknown>> = []
  semantic.on('event', (ev: Record<string, unknown>) => events.push(ev))
  const requests: Array<Record<string, unknown>> = []
  semantic.on('provider_request', (ev: Record<string, unknown>) => requests.push(ev))
  const request = (requestId: string): void => {
    proxy.emit('event', { kind: 'request', requestId, method: 'POST', path: '/v1/responses', upstream: UPSTREAM, endpoint: 'responses' })
  }
  const frames = (requestId: string, payloads: Frame[]): void => {
    const body = Buffer.from(payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join(''))
    proxy.emit('event', { kind: 'response-chunk', requestId, path: '/v1/responses', size: body.length, chunk: body, endpoint: 'responses' })
  }
  const end = (requestId: string): void => {
    proxy.emit('event', { kind: 'response-end', requestId, path: '/v1/responses', bytes: 0, endpoint: 'responses' })
  }
  return { adapter, events, requests, request, frames, end }
}

const phases = (events: Array<Record<string, unknown>>): unknown[] =>
  events.filter(ev => ev.type === 'stream_phase').map(ev => ev.phase)

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // The watchdog measures its own lateness from attach time.
  vi.setSystemTime(PROMPT_AT)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('CodexResponsesAdapter.sealFlowsSilentSince', () => {
  it('stops a turn mid tool-call with the interruption cause, publishes idle, and records the request as cancelled by the suspension', () => {
    const pane = mount()
    pane.request('req-1')
    pane.frames('req-1', [
      { type: 'response.created', response: { id: 'resp_tool_streaming' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_0', type: 'function_call', call_id: 'call_0', name: 'exec_command', status: 'in_progress' } },
    ])
    expect(phases(pane.events).at(-1)).toBe('tool-input')

    vi.setSystemTime(WAKE_AT)
    pane.adapter.sealFlowsSilentSince(SLEEP_AT, 'system-suspended')

    expect(pane.events.filter(ev => ev.type === 'turn_stopped')).toEqual([
      expect.objectContaining({ turnId: 'resp_tool_streaming', interruption: 'system-suspended' }),
    ])
    expect(phases(pane.events).at(-1)).toBe('idle')
    expect(pane.requests.at(-1)).toMatchObject({ requestId: 'req-1', phase: 'cancelled', cause: 'system-suspended' })
  })

  it('leaves a flow with an event after the sleep began untouched', () => {
    const pane = mount()
    pane.request('req-1')
    pane.frames('req-1', [
      { type: 'response.created', response: { id: 'resp_survived' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_0', type: 'reasoning' } },
    ])
    vi.setSystemTime(WAKE_AT)
    pane.frames('req-1', [{ type: 'response.reasoning_summary_text.delta', item_id: 'rs_0', delta: 'after wake' }])

    pane.adapter.sealFlowsSilentSince(SLEEP_AT, 'system-suspended')

    expect(pane.events.some(ev => ev.type === 'turn_stopped')).toBe(false)
    expect(phases(pane.events).at(-1)).toBe('thinking')
  })

  it('does not touch the phase of a completed flow whose client tool is still running', () => {
    const pane = mount()
    pane.request('req-1')
    pane.frames('req-1', [
      { type: 'response.created', response: { id: 'resp_tool' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_0', type: 'function_call', call_id: 'call_0', name: 'exec_command', status: 'in_progress' } },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'fc_0', type: 'function_call', call_id: 'call_0', name: 'exec_command', arguments: '{}' } },
      { type: 'response.completed', response: { id: 'resp_tool' } },
    ])
    pane.end('req-1')
    expect(phases(pane.events).at(-1)).toBe('awaiting-tool')

    vi.setSystemTime(WAKE_AT)
    pane.adapter.sealFlowsSilentSince(SLEEP_AT, 'system-suspended')

    expect(pane.events.some(ev => ev.type === 'turn_stopped')).toBe(false)
    expect(phases(pane.events).at(-1)).toBe('awaiting-tool')
  })
})

describe('CodexResponsesAdapter watchdog after a sleep', () => {
  it('defers a tick that arrives hours late, then releases a still-silent flow on the next tick', () => {
    const pane = mount()
    pane.request('req-1')
    pane.frames('req-1', [
      { type: 'response.created', response: { id: 'resp_silent' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_0', type: 'reasoning' } },
    ])

    vi.setSystemTime(WAKE_AT)
    vi.advanceTimersByTime(10_000)
    expect(pane.events.some(ev => ev.type === 'turn_completed')).toBe(false)
    expect(pane.requests.some(ev => ev.cause === 'watchdog-timeout')).toBe(false)

    vi.advanceTimersByTime(10_000)
    expect(pane.requests.some(ev => ev.cause === 'watchdog-timeout')).toBe(true)
    expect(pane.events.some(ev => ev.type === 'turn_completed')).toBe(true)
  })
})
