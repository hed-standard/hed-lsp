# HED-LSP Daemon

The daemon serves the HED engine over Hypertext Transfer Protocol (HTTP).
It is the third adapter over the same engine, beside the language server and the `hed-suggest` command line tool.
Hierarchical Event Descriptors (HED) annotations from an editor, a web page, or a service can be validated and completed with one call each.

The contract is versioned: every path starts with `/v1`, and every response body carries `"apiVersion": "1.0"`.
Within version 1 only additive changes are made, such as new response fields.
There are no accounts, Application Programming Interface (API) keys, or quotas.
The limits below exist only to protect the machine, and every one of them is an environment variable with a documented default.

## Running locally

```bash
bun install
bun run compile
cd server
node out/daemon/main.js
```

The daemon listens on `127.0.0.1:38530`, loads the schema allowlist in the background, and writes one JavaScript Object Notation (JSON) line to standard error when it is listening.
`bun run daemon` in `server/` does the same, and `hed-lsp-daemon` is the same program as a command after `bun link --global`.

```bash
curl -s http://127.0.0.1:38530/v1/health
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"strings":["Sensory-event, Red"],"schema":"8.4.0"}' \
  http://127.0.0.1:38530/v1/validate
```

Settings are read once from `HED_LSP_*` environment variables (see [Limits and settings](#limits-and-settings)).
A bad value stops the daemon before it listens, with a message that names the variable, and exit status 2.
On SIGTERM or SIGINT the daemon stops accepting connections, lets the requests in flight finish for up to 8 seconds, and exits 0.
Eight seconds is below the 10 seconds that Docker waits after SIGTERM before it sends SIGKILL.
Exit status 1 means a failure at run time, such as an address that cannot be bound.

## API reference, version 1

### Conventions

- Every response carries an `X-Request-Id` header, and the same ID is in the body of an error.
- A POST body must be a JSON object with the media type `application/json`.
  A charset parameter is allowed if it is UTF-8.
- A POST must carry a `Content-Length` header.
  A body sent in chunks, without a length, gets 411 `LENGTH_REQUIRED` before any of it is read.
- A route that answers GET also answers HEAD, with the status and headers of the GET, `Content-Length` included, and no body.
  HEAD on a POST route gets 405.
- A body that is not valid JSON gets 400 `INVALID_JSON`.
  A body that is JSON but not an object, such as an array, gets 400 `INVALID_REQUEST`.
- A field the endpoint does not define gets 400 `UNKNOWN_FIELD`, with the field names and the allowed names in `details`.
  A client that sends a field from a later 1.x version to an older daemon therefore gets an error, not silence.
- Batch results are an ordered array, and each item has its `index`.
  Duplicates, order, and names such as `__proto__` are preserved.
- A request that fails as a whole is an error with a status code.
  A bad item inside a batch is an `error` on that item, inside a 200 response.
- An error has one shape, for every code:

```json
{
 "apiVersion": "1.0",
 "error": {
  "code": "PAYLOAD_TOO_LARGE",
  "message": "the request body is larger than 524288 bytes",
  "details": { "maxBytes": 524288 }
 },
 "requestId": "22793564-5484-405e-a9d1-e7235d3e163e"
}
```

- Cross-Origin Resource Sharing (CORS) allows any origin to call the API with GET, POST, and OPTIONS, without credentials.
  `Access-Control-Expose-Headers` lists `Retry-After` and `X-Request-Id`, and an OPTIONS request is answered 204 with an `Allow` header.
  A preflight answer carries `Access-Control-Max-Age: 600`, so a browser asks once in ten minutes and not before each request.
- Responses carry `Cache-Control: no-store`.

### `GET /v1/health`

Answers 200 when the daemon can serve requests and 503 while it is starting.
Health is exempt from every limit when the request has no body, so a probe never competes with clients.

```json
{
 "apiVersion": "1.0",
 "status": "ok",
 "version": "0.4.0",
 "commit": "abc1234",
 "schemas": { "default": "8.5.0", "degraded": [] },
 "semantic": {
  "state": "disabled",
  "failures": 0,
  "index": "8.5.0,sc:score_2.1.0,la:lang_1.1.0"
 },
 "uptimeSeconds": 5
}
```

| Field | Meaning |
|---|---|
| `status` | `ok`; `degraded`, which is still 200, when the default schema runs on the bundled fallback or an allowlisted schema has failed; `starting`, which is 503 with `Retry-After: 1`, until the default schema has loaded or failed |
| `commit` | The source revision the image was built from, or `unknown` |
| `schemas.degraded` | The allowlisted schema specs that failed or run on the fallback |
| `semantic.state` | `disabled`, `loading`, `ready`, or `unavailable`; see [Semantic search](#semantic-search) |
| `semantic.failures` | Failed warm-ups in a row |

### `GET /v1/schemas`

Lists the allowlist with the load state of each schema.
`used` differs from `spec` when the bundled fallback ran.
A failed schema carries `retryAfterSeconds`, the time until a request may try it again.

```json
{
 "apiVersion": "1.0",
 "default": "8.5.0",
 "schemas": [
  { "spec": "8.5.0", "status": "loaded", "used": "8.5.0" },
  { "spec": "8.5.0,sc:score_2.1.0,la:lang_1.1.0", "status": "loaded", "used": "8.5.0,sc:score_2.1.0,la:lang_1.1.0" },
  { "spec": "8.4.0", "status": "loaded", "used": "8.4.0" },
  { "spec": "8.4.0,sc:score_2.1.0,la:lang_1.1.0", "status": "loaded", "used": "8.4.0,sc:score_2.1.0,la:lang_1.1.0" },
  { "spec": "8.3.0", "status": "loaded", "used": "8.3.0" }
 ]
}
```

#### Choosing a schema

Both POST endpoints take an optional `schema`.
Only the five schemas of the allowlist are served, because each loaded schema stays in memory.
A request without `schema` uses `8.5.0`, the standard schema alone, so a bare request does not accept library tags such as `sc:Modulator`.
`schema` may be a string or an array of strings.
It is split on commas, trimmed, and compared as a case-sensitive set, so `"8.4.0,sc:score_2.1.0,la:lang_1.1.0"`, `["la:lang_1.1.0", "sc:score_2.1.0", "8.4.0"]`, and a different order of the same parts name the same schema.
A value of another type gets 400 `INVALID_REQUEST`, and a spec outside the allowlist gets 400 `UNKNOWN_SCHEMA`, with the allowed specs in `details.allowed`.
A `schema` longer than 256 characters, or an array whose parts joined with commas are longer, gets 400 `UNKNOWN_SCHEMA` as well, without being parsed, because parsing costs time in proportion to its length.
The longest default entry is 34 characters.
The response names the schema as `schema: { requested, used }`.

### `POST /v1/validate`

```json
{ "strings": ["Sensory-event, Red", "Sensory-event, Not-a-tag", 42], "schema": "8.4.0" }
```

`strings` is an array of at most `MAX_STRINGS` (100) items, and each string is at most `MAX_STRING_CHARS` (4096) characters.
Any other item, a longer string or a value that is not a string, gets an `INVALID_STRING` error on that item and does not stop the others.
More strings than the limit get 400 `BATCH_TOO_LARGE`.

```json
{
 "apiVersion": "1.0",
 "schema": { "requested": "8.4.0", "used": "8.4.0" },
 "results": [
  { "index": 0, "valid": true, "issues": [], "issueCount": 0, "truncated": false },
  {
   "index": 1,
   "valid": false,
   "issues": [
    {
     "code": "TAG_INVALID",
     "level": "error",
     "message": "ERROR: [TAG_INVALID] Invalid tag - \"Not-a-tag\". Tag extensions must have a parent in the HED schema.  (For more information on this HED error, see https://hed-specification.readthedocs.io/en/latest/Appendix_B.html#tag-invalid.)",
     "bounds": [15, 24]
    }
   ],
   "issueCount": 1,
   "truncated": false
  },
  { "index": 2, "error": { "code": "INVALID_STRING", "message": "must be a string of at most 4096 characters" } }
 ]
}
```

- `valid` is true when no issue has the level `error`.
  A string with only warnings is valid.
- Each issue has `code`, the HED error code; `level`, `error` or `warning`; `message`; and `bounds`, the start and end character offsets in the string when the issue points at a part of it.
- `issueCount` is the number of issues found, and `valid` counts all of them, even those left out of `issues`.
- `truncated` is true when an issue was left out or a message was cut.
  A string with no issues is never truncated.
- A string with a repeated tag, such as `Red, Red`, gets the issue `TAG_EXPRESSION_REPEATED` with the validator's own message, like any other issue.
  The validator throws this issue instead of returning it, and the engine reports it with its code and message, not as an internal error.
- A string that makes the validator fail in any other way gets an item error, `INTERNAL_ERROR` with the message `validation failed`, and nothing of the exception is returned or logged.
  A string nested thousands of levels deep runs the validator out of stack (2045 levels, or 4095 characters, did on Node 26, and the depth varies with the Node version).

The answer is bounded because a string of n open parentheses gives about n + 2 issues, and each message quotes the string, so the output grows with the square of its length.
Three limits apply, and none of them changes `valid` or `issueCount`:

- `MAX_ISSUES_PER_STRING` (100): the first issues, in the order the engine found them.
- `MAX_ISSUE_MESSAGE_CHARS` (1024): a longer message is cut and ends with `...`.
  Ordinary messages are 227 to 309 characters, so they stay whole.
- `MAX_ISSUE_TEXT_CHARS` (1,048,576): the message characters of one whole response.
  Items fill this budget in order.
  The message that crosses it is cut to what is left, or dropped when fewer than 4 characters are left, and every later item has `issues: []`.
  Only message text spends the budget, so a string with no issues costs nothing.
  A request of 100 strings of 4096 open parentheses is answered in about 1.1 MB.

### `POST /v1/suggest`

```json
{ "queries": ["button press", "", ["x"]], "schema": "8.5.0", "top": 5, "semantic": true }
```

- `queries` is an array of at most `MAX_QUERIES` (50) items, or at most `MAX_SEMANTIC_QUERIES` (20) when `semantic` is true.
  The semantic limit applies whatever the state of the daemon, so whether a request is valid never depends on whether the model has loaded.
  Each query is a non-blank string of at most `MAX_QUERY_CHARS` (512) characters, and anything else gets an `INVALID_QUERY` error on that item.
- `top` is an integer from 1 to 50, 10 when absent.
  Any other value, including `0`, `51`, `1.5`, `"5"`, and `null`, gets 400 `INVALID_REQUEST`.
- `semantic` is a boolean, false when absent.

```json
{
 "apiVersion": "1.0",
 "schema": { "requested": "8.5.0", "used": "8.5.0" },
 "semantic": { "requested": true, "status": "disabled" },
 "results": [
  {
   "index": 0,
   "query": "button press",
   "suggestions": [{ "tag": "Button" }, { "tag": "Response-button" }, { "tag": "Mouse-button" }, { "tag": "Press" }, { "tag": "Push" }]
  },
  { "index": 1, "query": "", "error": { "code": "INVALID_QUERY", "message": "must be a non-empty string of at most 512 characters" } },
  { "index": 2, "error": { "code": "INVALID_QUERY", "message": "must be a non-empty string of at most 512 characters" } }
 ]
}
```

A suggestion is an object, so that more fields can be added later.
A query that fails inside the engine is an `INTERNAL_ERROR` on its own item, and the other queries still return.
The `semantic` object is present only when the request set `semantic: true`.
Its `status` says what happened to semantic search; see [Semantic search](#semantic-search).

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_JSON` | The body is not valid JSON in UTF-8 |
| 400 | `INVALID_REQUEST` | The body is not an object, or a field has the wrong type or value |
| 400 | `UNKNOWN_FIELD` | The body has a field the endpoint does not define |
| 400 | `BATCH_TOO_LARGE` | More items than `MAX_STRINGS`, `MAX_QUERIES`, or `MAX_SEMANTIC_QUERIES` |
| 400 | `UNKNOWN_SCHEMA` | The schema is not in the allowlist; `details.allowed` lists them |
| 404 | `NOT_FOUND` | No such path |
| 405 | `METHOD_NOT_ALLOWED` | Wrong method for the path; the `Allow` header lists the right ones |
| 408 | `REQUEST_TIMEOUT` | The body was still incomplete `BODY_TIMEOUT_MS` after the headers; the connection is closed |
| 411 | `LENGTH_REQUIRED` | A POST without `Content-Length`, such as a chunked body; refused before the body is read |
| 413 | `PAYLOAD_TOO_LARGE` | The body is larger than `MAX_BODY_BYTES`, by its Content-Length; refused before the body is read |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | The Content-Type is not `application/json` in UTF-8 |
| 429 | `RATE_LIMITED` | The client is over its rate; `Retry-After` gives whole seconds |
| 500 | `INTERNAL_ERROR` | An unexpected failure; the message is generic and the detail is in the log |
| 503 | `STARTING` | The default schema has not loaded yet; `Retry-After: 1` |
| 503 | `OVERLOADED` | The client already has `MAX_IN_FLIGHT_PER_CLIENT` requests running, or all clients together have `MAX_IN_FLIGHT`, or a POST finds `MAX_PENDING_BODIES_PER_CLIENT` bodies of the client still arriving; `Retry-After: 1` |
| 503 | `SEMANTIC_BUSY` | The semantic slot and its queue are full; `Retry-After: 5` |
| 503 | `SCHEMA_UNAVAILABLE` | The schema failed to load and is waiting out its backoff; `Retry-After` gives the wait |
| 503 | `TIMEOUT` | The request ran past `REQUEST_TIMEOUT_MS`; `Retry-After: 1`, and the connection is closed |
| 200, on an item | `INVALID_STRING`, `INVALID_QUERY`, `INTERNAL_ERROR` | One item of a batch failed; the others are unaffected |

A schema that failed to load is not tried again by every request that names it.
The daemon answers 503 `SCHEMA_UNAVAILABLE` until the backoff has passed, 30 seconds doubling to 10 minutes, so a GitHub outage is not hammered.
`Retry-After` is always a whole number of seconds.

## Limits and settings

Every setting is an environment variable with the prefix `HED_LSP_`.
The values below are starting values chosen to keep one shared machine safe, and they will be tuned once they have been measured on the public host.

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` (the image: `0.0.0.0`) | Address to listen on |
| `PORT` | `38530` | Port to listen on; `0` picks a free one |
| `TRUSTED_PROXIES` | `127.0.0.1,::1` | Addresses whose `X-Forwarded-For` header is believed; an empty value trusts no one |
| `SCHEMAS` | the five schemas above, separated by `;` | The allowlist |
| `DEFAULT_SCHEMA` | `8.5.0` | The allowlisted schema used when a request names none |
| `SCHEMA_LOAD_TIMEOUT_MS` | `60000` | How long one schema load may take; the validator's own fetch has no timeout |
| `SEMANTIC` | `0` | `1` turns on semantic search |
| `ONNX_THREADS` | `1` | Threads for the Open Neural Network Exchange (ONNX) runtime that runs the embedding model |
| `MODEL_DOWNLOAD` | `1` (the image: `0`) | Whether the daemon may download the embedding model |
| `MAX_BODY_BYTES` | `524288` | Largest request body, 512 KiB |
| `MAX_STRINGS` | `100` | Strings in one validate request |
| `MAX_STRING_CHARS` | `4096` | Characters in one string; the longest string of the evaluation set is 381 |
| `MAX_ISSUES_PER_STRING` | `100` | Issues returned for one string |
| `MAX_ISSUE_MESSAGE_CHARS` | `1024` | Characters in one issue message; at least 4 |
| `MAX_ISSUE_TEXT_CHARS` | `1048576` | Message characters in one validate response |
| `MAX_QUERIES` | `50` | Queries in one suggest request |
| `MAX_SEMANTIC_QUERIES` | `20` | Queries in one suggest request with `semantic: true` |
| `MAX_QUERY_CHARS` | `512` | Characters in one query; the longest in the evaluation set is 110 |
| `RATE_ITEMS_PER_SEC`, `RATE_ITEMS_BURST` | `100`, `1000` | Refill rate and size of each client's general bucket, in units |
| `SEMANTIC_RATE_PER_SEC`, `SEMANTIC_RATE_BURST` | `1`, `20` | The same for each client's semantic bucket |
| `CHARGE_CHARS_PER_UNIT` | `256` | Characters that cost one unit of charge |
| `MAX_IN_FLIGHT` | `8` | Requests running at once, all clients together |
| `MAX_IN_FLIGHT_PER_CLIENT` | `4` | Requests running at once for one client |
| `MAX_PENDING_BODIES_PER_CLIENT` | `4` | Bodies of one client still arriving at once; they hold no in-flight slot |
| `SEMANTIC_CONCURRENCY` | `1` | Semantic requests running at once; 1 is the only accepted value |
| `SEMANTIC_QUEUE` | `8` | Semantic requests waiting for the slot |
| `REQUEST_TIMEOUT_MS` | `30000` | Time for a whole request, queue wait included |
| `BODY_TIMEOUT_MS` | `10000` | Time for a request body to arrive in full, counted from the headers |
| `HEADERS_TIMEOUT_MS` | `10000` | Time for the headers to arrive; at most the request timeout plus 5000 |
| `WRITE_STALL_MS` | `10000` | Time a response being written may go with no progress before its connection is reset; at least 1 |
| `WRITE_TOTAL_MS` | `60000` | Time the whole write of one response may take, whatever its progress, before its connection is reset; at least 1 |
| `KEEPALIVE_TIMEOUT_MS` | `65000` | Idle time before a connection is closed, longer than a proxy's reuse window |
| `MAX_CONNECTIONS` | `256` | Open connections |
| `MAX_CLIENTS` | `10000` | Clients tracked for rate limiting |
| `CLIENT_IDLE_MS` | `600000` | How long an idle client is remembered, 10 minutes |
| `COMMIT` | `unknown` | The revision reported by health; the image sets it from a build argument |

### How requests are charged

Each client has a bucket of units that refills at `RATE_ITEMS_PER_SEC` up to `RATE_ITEMS_BURST`.

- Every request except a GET or HEAD of `/v1/health` that has no body pays at the door, before anything else is done with it and before a byte of its body is read.
  A request pays one unit for each 4096 bytes of body it declares in `Content-Length`, rounded up and at least one, whatever its method, so a large body costs more than a small one even when it is refused, on a GET or an unknown path as on a POST.
  A request that declares no length, such as one with a chunked body, pays one unit.
  Unknown paths, wrong methods, and OPTIONS requests are limited like other traffic.
  A GET of health that carries a body pays like any other request, because the daemon has to read and discard the body.
- A request then pays for what it asks.
  A string or a query costs `max(1, ceil(length / CHARGE_CHARS_PER_UNIT))` units, and an item that is not a string costs one.
  The door counts toward this charge: a request costs the larger of what the door took and what its items cost, and never more than the burst, so an empty batch is not free.
- Time grows with length, which is why length is charged: a string of 4096 open parentheses, the slowest kind measured, takes 19.5 to 25 ms to validate, and 100 of them take 2.2 s of processor time, while 4096 characters of ordinary text take 3.9 ms.
  An ordinary string costs 1 unit, and a string of 4096 characters costs 16.
- A request that costs more than the burst is charged the whole burst, so it can pass from a full bucket.
  At the defaults, 100 strings of 4096 characters cost 1600 units, are charged 1000, and can be sent about once every 10 seconds.
- A request that asks for semantic search and runs it is charged the same number of units against the semantic bucket as well.
- Nothing is refunded.
  A charge is for the request and not for its result, so a request that is refused for its rate, its schema, a full queue, a timeout, or a daemon that is busy or starting keeps what it paid, the door included.
  A client that is over its rate gets 429 `RATE_LIMITED` with `Retry-After`, the whole seconds after which the same request would pass, counting the door that the next attempt pays again.
- The buckets read a monotonic clock, so a change of the system clock does not stop a bucket from refilling or end a schema backoff early.
  The uptime in health and the time of each request read it too, so neither jumps or goes negative when the system clock is set.

### Who a client is

The rate limit is per client address.
The address of the connection is used, unless it is in `TRUSTED_PROXIES`, in which case the rightmost entry of `X-Forwarded-For` is used, which is the one the proxy itself appended.
Only that entry is read.
If it is not an Internet Protocol (IP) address, the address of the connection is used, and the entries to its left are never looked at.
An IPv6 client is limited by its /64 prefix, because one subscriber usually controls a whole /64.
When the daemon listens on an address other than loopback and trusts only the default proxies, every client reaches it through some other address and shares one key, so the daemon warns at startup.
Set `TRUSTED_PROXIES` to the address of the proxy in front of it.

### Requests in flight and timeouts

A body is input, not work, so a client that sends one slowly holds no in-flight slot.
A POST takes one of its client's pending-body slots while its body is arriving, `MAX_PENDING_BODIES_PER_CLIENT` of them (4), and gives it back when the body is complete, when `BODY_TIMEOUT_MS` has passed, or when the request ends.
A POST over that count gets 503 `OVERLOADED` with `Retry-After: 1` before its body is read.
A slow sender can therefore hold at most four connections, for at most `BODY_TIMEOUT_MS` each, and never a slot that another client's work needs.
A body that is still incomplete `BODY_TIMEOUT_MS` after the headers gets 408 `REQUEST_TIMEOUT` and the connection is closed, so it holds its pending-body slot for 10 seconds and not for the whole request timeout.

A request is in flight from the moment its body is complete, or at once when it has none, until its work stops.
Two caps apply: `MAX_IN_FLIGHT_PER_CLIENT` for one client, so that one client cannot take every slot, and `MAX_IN_FLIGHT` for all clients together.
A request over either cap gets 503 `OVERLOADED` with `Retry-After: 1`; its body has been read by then.
A request that runs past `REQUEST_TIMEOUT_MS` is answered 503 `TIMEOUT`.
Its work stops between items, and it keeps its slot until then; a semantic run that has already started finishes.
Node's own request timer is set 5 seconds past the daemon's, so the daemon always answers first.

A request that is refused before its body is read, for whatever reason, does not leave the client free to keep sending.
The daemon reads and drops up to four times `MAX_BODY_BYTES` of the body, counted from its first byte (2 MiB by default), so a client that sends a little more than the limit still reads the answer, and it closes the connection past that.
The same holds for a body that nobody reads on a request that is answered, such as a GET with a body.
The discard has a deadline too: a body that is not complete `BODY_TIMEOUT_MS` after the answer ends the connection, so a body dripped in a byte at a time cannot hold it open.

A response that is being written is bounded twice, by `WRITE_STALL_MS` (10 seconds) and by `WRITE_TOTAL_MS` (60 seconds).
The daemon writes the body in pieces of 64 KiB, each after the socket has taken the one before, and when the write makes no progress for that long it resets the connection.
Progress is a drain of the socket or a piece written out, so a client that reads a large answer slowly but steadily is not stalled, and a client that sends a request and then stops reading loses its connection after `WRITE_STALL_MS`.
A slow but steady reader makes progress for as long as it likes, so the total bound ends it: a response whose write has not finished `WRITE_TOTAL_MS` after it began is reset, whatever its progress.
At the defaults the largest answer is about 1.1 MB, so a client has to read at about 20 KB a second or faster to receive it.
The watchdog runs only while a response is pending; it stops when the response is finished or the connection closes or fails, so it never touches an idle kept-alive connection.
The operating system's buffers take in the first part of an answer whether or not the client reads it, at least 2.4 MB on a macOS loopback connection, so a write stalls only for an answer larger than the buffers of the two ends.

Node's socket timeout is set to `REQUEST_TIMEOUT_MS` plus 5 seconds, so a connection that moves no bytes at all is closed.
It stays as a backstop, and it is not the bound for a stalled write: Node does not fire it while a write is in progress until a whole period has passed with the write unmoved, so a stuck write is closed after two to three periods, about 70 to 105 seconds with the defaults, which is why `WRITE_STALL_MS` exists.
A kept-alive connection that is idle between requests is closed after `KEEPALIVE_TIMEOUT_MS` instead, plus one second that Node adds, and the socket timeout does not shorten that.

## Semantic search

Semantic search finds tags by meaning with an embedding model, and it is off by default.
`HED_LSP_SEMANTIC=1` turns it on.

- The daemon owns the model.
  When semantic search is on, the model loads in the background after the server starts listening, so no request waits for the load, and a download of about 600 MB is never part of a request.
  The image sets `MODEL_DOWNLOAD=0`, so a running daemon never downloads; seed the model cache once with a run that allows it.
- `semantic.state` in health is `disabled`, `loading` (the first warm-up has not finished), `ready`, or `unavailable` (a warm-up failed).
  A failed warm-up is retried in the background after 30 seconds, then after 60, doubling up to 15 minutes, and never because a request arrived.
- A request with `semantic: true` always gets its keyword and schema results.
  `semantic.status` in the response is `ok` when the model was ready and the step did not fail, `disabled`, `loading`, or `unavailable`.
  All four are HTTP 200.
- The semantic step runs only for a query whose keyword and schema results are fewer than `top` tags.
  A request whose queries all found enough tags without it is `ok` and did not use the model.
- Inference runs on the main thread, so the daemon runs one semantic request at a time and holds at most `SEMANTIC_QUEUE` others in a queue.
  A request that finds both full gets 503 `SEMANTIC_BUSY` with `Retry-After: 5`.
  The daemon yields between queries, so a request that does not ask for semantic search waits for at most one embedding.
- `ONNX_THREADS` sets the threads of the embedding runtime.
  The default is 1; set it to the number of processors the daemon may use.

## What is logged and kept

The daemon writes one JSON line per request to standard error: the time, the request ID, the method, the path without its query string, the status, the milliseconds, the number of items, the schema used, the semantic status, the error code, and whether the client went away before the answer was sent.
A path that is not a route is logged as `unknown route`, because it is the client's text, and a request that was cut off before its answer was written is logged with `aborted: true` and no status.
A connection that is reset because its response stalled gets one more line, a warning with the request ID and no other detail.
Engine messages go through the same writer as JSON lines.
An unexpected exception is logged by its type and its stack frames, never its message, which can quote the request, and the engine's own log lines name an error by its type for the same reason.

- Request bodies, queries, HED strings, and IP addresses are never logged.
  A test checks that no log line carries request text.
- IP addresses exist only in the in-memory rate table.
  An entry is dropped after 10 minutes without a request, the table is bounded by `MAX_CLIENTS`, and nothing is written to disk.
- The daemon stores nothing else about a request.

A reverse proxy in front of the daemon, such as Apache, has its own logs, and they follow that server's policy.

## The container image

The `Dockerfile` at the root builds the daemon for `linux/amd64`.
The build stage runs on the Bun image, installs with `bun install --frozen-lockfile`, compiles, and installs only the production dependencies with `bun install --frozen-lockfile --production`.
The runtime stage is `node:22-bookworm-slim`.
Both base images are pinned by digest, and both stages are pinned to `linux/amd64` with `FROM --platform`, so the build gives the same image on any host.
BuildKit's linter warns about a constant platform in `FROM`; the warning is expected.
Dependabot proposes updates to the digests.
The `.dockerignore` keeps environment files, built extensions, agent notes, and logs out of the build context.

```bash
docker buildx build --platform linux/amd64 \
  --build-arg HED_LSP_COMMIT=$(git rev-parse --short HEAD) -t hed-lsp-daemon:local .

docker run -d --name hed-lsp --restart unless-stopped \
  --stop-timeout 15 \
  -p 127.0.0.1:38530:38530 \
  --read-only --tmpfs /tmp \
  -v hed-lsp-cache:/home/node/.cache \
  -e HED_LSP_TRUSTED_PROXIES=<address of the proxy in front> \
  hed-lsp-daemon:local
```

- The process runs as the `node` user and listens on `0.0.0.0:38530` inside the container.
  Publish the port on the loopback address of the host, and let a reverse proxy face the network.
- `--stop-timeout 15` is recommended.
  The daemon drains for 8 seconds after SIGTERM, below Docker's default stop timeout of 10 seconds, and 15 leaves room for the exit that follows.
- `/home/node/.cache` is the mount point of the model cache, owned by `node`.
- The image has no `curl`, so its `HEALTHCHECK` runs `node out/daemon/healthcheck.js`, which asks for `/v1/health` and succeeds for `ok` and `degraded`.
- Measured in a local container, the daemon used about 200 MiB with semantic search off and about 2 GiB with it on and the model loaded.
  The image is about 390 MB compressed and about 830 MB on disk.
- A reverse proxy that strips a path prefix, such as `/hed-lsp/`, passes `/hed-lsp/v1/health` to the daemon as `/v1/health`.
  A proxy can enforce the same body limit, for example with `LimitRequestBody 524288` in Apache.

`scripts/daemon-smoke.sh` is the smoke test of a running daemon.
It checks health, the schema list, a valid and an invalid string, a suggestion, a 413, a 400 for an unknown field, and that `dataDir()` resolves to `/app/server/data` in the container.

```bash
HED_LSP_DAEMON_URL=http://127.0.0.1:38530 HED_LSP_DAEMON_CONTAINER=hed-lsp scripts/daemon-smoke.sh
```

With `--offline` it expects a daemon that has no network, as when the container runs with `--network none`, which publishes no port: copy the script into the container with `docker cp` and run it with `docker exec`.
Offline, the daemon is `degraded`.
Schema 8.5.0 is served by the bundled 8.4.0 and says so in `used`.
8.5.0 with the libraries is refused as `SCHEMA_UNAVAILABLE`.
8.4.0, with or without the libraries, and 8.3.0 load from the bundled files.

Continuous integration builds the image and runs both smoke tests for a pull request into `main` and for a push to `main`.
A push to `main` then publishes the tested image to `ghcr.io/hed-standard/hed-lsp-daemon`, tagged with the package version and `sha-<short commit>`, and never `latest`.
The publish job waits for approval in the `ghcr-publish` environment and prints the digest.
Deploy by digest.

## Measuring a running daemon

`server/src/daemon/loadTest.ts` is a load harness.
After `bun run compile`, `node out/daemon/loadTest.js --help` lists its options.

```bash
node out/daemon/loadTest.js --url http://127.0.0.1:38530 --concurrency 4 --duration 60 \
  --mix suggest=60,validate=30,semantic=10 --clients 64 --out load.json
```

It sends requests built from the 206 description and HED pairs of `server/eval/hed-examples-pairs.json`.
The JSON report has, for each endpoint and for the run, the p50, p95, and p99 latency in milliseconds, the error rate, the 429 and 503 answers counted by error code, and the throughput, with the run parameters and `/v1/health` before and after.
`--clients` sends that many distinct `X-Forwarded-For` addresses, so the per-client limits apply to each separately.
The target honors the header only when the address of the machine running the harness is in its `TRUSTED_PROXIES`; otherwise every request shares one key.

## Known limits

- The language server has the same quadratic output for a long string in a document: a string of n open parentheses makes about n + 2 diagnostics that each quote the string.
  The daemon bounds its answer, and the language server does not; that is outside this change.
- If GitHub cannot be reached when the daemon starts, the default schema `8.5.0` is served by the bundled 8.4.0, and the response says so in `used`, until the daemon restarts, because the engine keeps the fallback.
  Only the exact schema `8.5.0` has a fallback.
  Schema 8.5.0 with the libraries is refused until GitHub is reachable again and its backoff, 30 seconds doubling to 10 minutes, has passed.
- Semantic suggestions come from the index built for 8.5.0 with SCORE and LANG, whichever schema the request names, and a library tag appears without its prefix.
  Both are known defects of the semantic step and are outside this change.
- Semantic inference runs on the main thread.
  One embedding holds the event loop for about 20 milliseconds on a fast desktop computer, and an embedding already running always finishes, even when its request has timed out.
  Moving it to a worker thread is the remedy if non-semantic latency suffers.
- Concurrent requests are interleaved: a long batch yields between items, so requests share the thread and each takes longer.
  This is deliberate, because it keeps small requests responsive while a large one runs, and the caps on requests in flight bound the overload.
- Some informational engine messages, such as a schema being loaded, are logged at level `error`, because the engine writes them to standard error.
- The limits are starting values and have not yet been measured on the public host.
