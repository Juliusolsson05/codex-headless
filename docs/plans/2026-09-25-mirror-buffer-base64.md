# The proxy mirror writes chunks as decimal byte arrays, not base64 (agent-code#372)

## Evidence
- One Codex session's `proxy-events.jsonl` (2026-09-25, about 10 h) is 3.19 GB. By event kind:
  - `response-chunk`: 2,266 MiB (74.5 %) across 384,733 events, although those chunks carry only 621 MiB of payload, a 3.65× blow-up;
  - `request`: 775 MiB (25.5 %).
- Every recorded chunk line reads `"chunk":{"type":"Buffer","data":[123,34,…]}`, which is the decimal byte-array form. The 34 local dumps contain no `_buffer_b64`.
- The cause: `JSON.stringify` calls `Buffer.prototype.toJSON` BEFORE the replacer runs, so `ResponsesProxy.emit`'s replacer never sees a `Buffer`. The base64 substitution it was written for (and that `API.md` documents) has never happened. `node -e 'JSON.stringify({c:Buffer.from("hi")},(k,v)=>Buffer.isBuffer(v)?1:v)'` prints `{"c":{"type":"Buffer","data":[104,105]}}`.

## Change
- The replacer reads the holder's raw value (`this[key]`), not the post-`toJSON` value, so a `Buffer` becomes `{ _buffer_b64 }` as documented.
- base64 rather than UTF-8 text, because a network chunk can split a multi-byte character.
- Expected effect on the file above: chunks drop from 2,266 to about 830 MiB, with no change to what is recorded.

## Out of scope (stays on agent-code#372)
- Per-file byte caps and dropped counters.
- Request-body mirroring (775 MiB above).
- Moving the write off the synchronous path.

## Tests
A real recorded chunk (`event: response.created\n`, 24 bytes; 204 bytes on disk today) and a chunk that splits a UTF-8 character. The mirrored line must round-trip the exact bytes through `_buffer_b64` and stay under the base64 size bound. Red on main.
