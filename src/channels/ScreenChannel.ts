import { EventEmitter } from 'events'

import type {
  ScreenActivityEvent,
  ScreenApprovalEvent,
  ScreenEvent,
  ScreenSnapshotEvent,
  ScreenTrustDialogEvent,
} from './types.js'

// Codex ScreenChannel — what the TUI is painting right now.
// Mirrors the Claude package's ScreenChannel; see that file and
// src/channels/types.ts for the architectural rationale.

export type ScreenChannelEvents = {
  event: [ScreenEvent]
  snapshot: [ScreenSnapshotEvent]
  activity: [ScreenActivityEvent]
  trust_dialog: [ScreenTrustDialogEvent]
  approval: [ScreenApprovalEvent]
}

export interface ScreenChannel {
  on<K extends keyof ScreenChannelEvents>(
    event: K,
    listener: (...args: ScreenChannelEvents[K]) => void,
  ): this
  off<K extends keyof ScreenChannelEvents>(
    event: K,
    listener: (...args: ScreenChannelEvents[K]) => void,
  ): this
  emit<K extends keyof ScreenChannelEvents>(
    event: K,
    ...args: ScreenChannelEvents[K]
  ): boolean
}

export class ScreenChannel extends EventEmitter {
  publishSnapshot(params: { plain: string; markdown: string }): void {
    const ev: ScreenSnapshotEvent = {
      type: 'snapshot',
      plain: params.plain,
      markdown: params.markdown,
      ts: Date.now(),
    }
    this.emit('snapshot', ev)
    this.emit('event', ev)
  }

  publishActivity(params: { active: boolean; status: string | null }): void {
    const ev: ScreenActivityEvent = {
      type: 'activity',
      active: params.active,
      status: params.status,
      ts: Date.now(),
    }
    this.emit('activity', ev)
    this.emit('event', ev)
  }

  publishTrustDialog(state: ScreenTrustDialogEvent['state']): void {
    const ev: ScreenTrustDialogEvent = {
      type: 'trust_dialog',
      state,
      ts: Date.now(),
    }
    this.emit('trust_dialog', ev)
    this.emit('event', ev)
  }

  publishApproval(params: {
    visible: boolean
    state: ScreenApprovalEvent['state']
  }): void {
    const ev: ScreenApprovalEvent = {
      type: 'approval',
      visible: params.visible,
      state: params.state,
      ts: Date.now(),
    }
    this.emit('approval', ev)
    this.emit('event', ev)
  }
}
