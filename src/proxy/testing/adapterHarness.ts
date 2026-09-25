import { EventEmitter } from 'node:events'

import { onTestFinished } from 'vitest'

import { SemanticChannel } from '../../channels/SemanticChannel.js'
import { CodexResponsesAdapter } from '../CodexResponsesAdapter.js'
import type { ResponsesProxy } from '../responsesProxy.js'

// A bare EventEmitter standing in for the real ResponsesProxy.
//
// WHY a fake and not the real proxy: every adapter behaviour we care about
// is a pure function of the `event` stream the proxy emits, and the events
// pasted into the tests are sanitized copies of real proxy-events.jsonl
// lines. Booting an HTTP listener to replay them would add sockets, ports
// and async teardown to assertions that are otherwise synchronous.
class RecordedProxy extends EventEmitter {}

export type RecordedAdapterHarness = {
  /** Emit sanitized `event` payloads on this to drive the adapter. */
  proxy: RecordedProxy
  /** The channel the adapter publishes onto; subscribe or spy on it. */
  semantic: SemanticChannel
  /** Already attached. Exposed for tests that assert on detach behaviour. */
  adapter: CodexResponsesAdapter
}

/** Build an attached adapter wired to a fake proxy and a fresh
 *  SemanticChannel.
 *
 *  WHY this lives in src/ rather than inside one test file: the HTTP-failure
 *  suite needs exactly the same wiring as the recorded-traffic suite, and a
 *  second hand-rolled copy would drift the moment the constructor gains an
 *  argument. It is excluded from tsconfig.build.json so the `vitest` import
 *  below never reaches dist/ — this module is test-only scaffolding that
 *  happens to sit next to the code it wires up.
 *
 *  WHY it self-registers cleanup instead of leaving detach to the caller:
 *  `attach()` arms the adapter's watchdog `setInterval`. A caller that
 *  forgets to detach leaves a live timer behind for the rest of the file,
 *  which both keeps a dead flow's state reachable and can hold the worker's
 *  event loop open. `onTestFinished` binds the teardown to the test that
 *  asked for the harness, so no suite has to remember. */
export function createRecordedAdapterHarness(): RecordedAdapterHarness {
  const proxy = new RecordedProxy()
  const semantic = new SemanticChannel()
  const adapter = new CodexResponsesAdapter(
    proxy as unknown as ResponsesProxy,
    // The adapter only ever touches `semantic` and
    // `observeProviderThreadIdentity` on its headless handle. The second is a
    // no-op here: real traffic DOES carry `request_shape.provider_session_id`
    // (the flow-retention fixture does), and without the member the adapter
    // threw on the request and never created a flow, so a leak assertion
    // passed for the wrong reason. A full CodexHeadless would be dead weight.
    { semantic, observeProviderThreadIdentity: () => {} } as never,
  )
  adapter.attach()
  onTestFinished(() => {
    adapter.detach()
  })
  return { proxy, semantic, adapter }
}
