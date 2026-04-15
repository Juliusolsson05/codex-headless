import { EventEmitter } from 'events'

import {
  extractCodexMessageText,
  isCodexResponseItem,
  isCodexSessionMeta,
  type CodexMessageItem,
  type CodexResponseItem,
  type CodexRolloutLine,
  type CodexSessionMeta,
} from '../transcript/TranscriptTypes.js'
import type {
  CommittedEvent,
  CommittedResponseItemEvent,
  CommittedRolloutLineEvent,
  CommittedSessionMetaEvent,
  CommittedTurnEvent,
} from './types.js'

// Codex CommittedChannel — durable, persisted truth.
//
// Every event on this channel corresponds to a line already written
// to a rollout-*.jsonl file by Codex. Unlike the semantic channel
// (which can be reconciled or retracted), committed events describe
// settled history and are safe to persist in the app's feed/log.
//
// WHY a separate channel (not just a filtered semantic stream):
// settled history and live progress have different failure modes.
// We do not want the app to guess which rollout entries are durable
// enough to store — anything here IS durable, that's the contract.

export type CommittedChannelEvents = {
  event: [CommittedEvent]
  turn_committed: [CommittedTurnEvent]
  response_item: [CommittedResponseItemEvent]
  session_meta: [CommittedSessionMetaEvent]
  rollout_line: [CommittedRolloutLineEvent]
  error: [Error]
}

export interface CommittedChannel {
  on<K extends keyof CommittedChannelEvents>(
    event: K,
    listener: (...args: CommittedChannelEvents[K]) => void,
  ): this
  off<K extends keyof CommittedChannelEvents>(
    event: K,
    listener: (...args: CommittedChannelEvents[K]) => void,
  ): this
  emit<K extends keyof CommittedChannelEvents>(
    event: K,
    ...args: CommittedChannelEvents[K]
  ): boolean
}

export class CommittedChannel extends EventEmitter {
  /** Feeds one rollout JSONL line into the channel. Emits:
   *   - always: `rollout_line` (raw envelope)
   *   - when the line is a response_item message: `turn_committed`
   *   - when the line carries session_meta: `session_meta`
   *   - when the line is any other response_item: `response_item`
   *
   * The mapping stays in the package (not the app) because "which
   * rollout entries constitute a committed turn" is a Codex-protocol
   * concept and should not be reinvented by every consumer. */
  publishLine(line: CodexRolloutLine, file: string): void {
    const ts = Date.now()

    const raw: CommittedRolloutLineEvent = {
      type: 'rollout_line',
      line,
      file,
      ts,
    }
    this.emit('rollout_line', raw)
    this.emit('event', raw)

    if (isCodexSessionMeta(line)) {
      const meta = line.payload as CodexSessionMeta
      const ev: CommittedSessionMetaEvent = {
        type: 'session_meta',
        meta,
        file,
        ts,
      }
      this.emit('session_meta', ev)
      this.emit('event', ev)
      return
    }

    if (isCodexResponseItem(line)) {
      const item = line.payload as CodexResponseItem
      const itemEv: CommittedResponseItemEvent = {
        type: 'response_item',
        item,
        file,
        ts,
      }
      this.emit('response_item', itemEv)
      this.emit('event', itemEv)

      if (item.type === 'message') {
        const message = item as CodexMessageItem
        // response_item messages do not carry a per-line uuid the way
        // Claude's JSONL does. The item's own `id` is usually present
        // (upstream OpenAI API id); fall back to a fingerprint of
        // role + timestamp + short text prefix so consumers always
        // have a stable key for dedupe and feed rendering.
        const role = message.role as CommittedTurnEvent['role']
        const text = extractCodexMessageText(message)
        const turnId =
          message.id ??
          `committed-${role}-${line.timestamp}-${text.slice(0, 32)}`
        const ev: CommittedTurnEvent = {
          type: 'turn_committed',
          turnId,
          role,
          text,
          item: message,
          file,
          ts,
        }
        this.emit('turn_committed', ev)
        this.emit('event', ev)
      }
    }
  }

  publishError(err: Error): void {
    this.emit('error', err)
  }
}
