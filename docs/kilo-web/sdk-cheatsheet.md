# SDK cheat sheet

> Filled out during M1.6. Currently a skeleton — agents should append real types/signatures as they exercise each API.

## Client construction

```ts
import { createKiloClient } from "@kilocode/sdk/v2/client"

const client = createKiloClient({
  baseUrl: "http://127.0.0.1:8787",
  directory: "/Users/me/path/to/workspace", // confirm header/option name during M1.6
})
```

## Sessions

```ts
const sessions = await client.session.list()
const created = await client.session.create({ /* title? */ })
const sessionID = created.id // confirm field name
```

## Messaging

```ts
// Send + stream (mechanism TBD — confirm whether response is JSON or SSE)
await client.session.prompt({ sessionID, content: [...] })
```

## Events (SSE)

```ts
const es = new EventSource("http://127.0.0.1:8787/event")
es.addEventListener("message.part.delta", (e) => { /* JSON.parse(e.data) */ })
es.addEventListener("message.updated", ...)
es.addEventListener("permission.requested", ...)
```

## PTY (WebSocket)

```ts
const { id: ptyID } = await client.pty.create({ /* shell?, cols, rows */ })
const ws = new WebSocket(`ws://127.0.0.1:8787/pty/${ptyID}/connect`)
ws.binaryType = "arraybuffer"
ws.onmessage = (e) => term.write(new Uint8Array(e.data))
term.onData((d) => ws.send(d))
```

## Find

```ts
const hits = await client.file.text({ query: "TODO" })
const files = await client.file.file({ query: "*.ts" })
const symbols = await client.file.symbol({ query: "WebClaw" })
```

## Permission

```ts
await client.permission.respond({ permissionID, decision: "allow" | "deny" | "allow_once" })
```

## TODO (fill in as discovered)

- [ ] Exact directory/workspace header name and acceptable values
- [ ] Auth header format (Bearer? Basic? token query?)
- [ ] Message content block shape (text vs file vs image)
- [ ] How streaming response is delivered (chunked JSON vs SSE)
- [ ] Pagination shape for `session.message.list`
- [ ] PTY message framing on WebSocket (binary? text? JSON wrapper?)
