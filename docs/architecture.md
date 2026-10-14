# Architecture

## Components

```mermaid
flowchart LR
  subgraph clients["Clients (speak as the user)"]
    panel["Desktop side panel<br/>from=panel"]
    voice["Voice assistant<br/>from=voice"]
    phone["Phone PWA<br/>from=phone"]
  end
  scripts["Scripts / schedulers<br/>(data, never orders)"]

  subgraph server["Server (always on)"]
    channel["Channel server<br/>channel/src/channel.ts<br/>HTTP + SSE + MCP over stdio"]
    hub["QG hub<br/>permanent Claude Code session<br/>CLAUDE.md + skills + agents"]
    state[("State dir<br/>outbox.jsonl<br/>outbox-state.json<br/>channel.jsonl")]
  end

  subgraph workers["Background workers (claude --bg)"]
    w1["worker A<br/>(server)"]
    w2["worker B<br/>(other machine, via ssh)"]
  end

  ntfy["ntfy server"] --> mobile["Phone notification"]

  panel -- "POST /v1/chat/completions" --> channel
  voice -- "POST /message" --> channel
  phone -- "POST /message" --> channel
  scripts -- "POST /message, /v1/notify" --> channel
  channel <-- "MCP channel:<br/>notifications/claude/channel in,<br/>tools reply + notify out" --> hub
  channel --- state
  channel -- "SSE /v1/events<br/>POST /v1/seen" --> panel
  channel -- "SSE /v1/events" --> phone
  channel -- "push per urgency policy" --> ntfy
  hub -- "claude --bg + written brief" --> w1
  hub -- "ssh ... claude --bg" --> w2
  w1 -- "SendMessage: DONE / BLOCKED + proof" --> hub
  w2 -- "SendMessage: DONE / BLOCKED + proof" --> hub
```

The hub is one long-lived Claude Code session started by `template/run-qg.sh`. The channel server is an MCP server
that Claude Code launches itself (see `template/.mcp.json.example`); it also opens an HTTP port so that anything
that is not Claude Code can reach the session. It is the only way the hub talks to the user.

## Delegation loop

```mermaid
sequenceDiagram
  actor U as User
  participant H as Hub (QG)
  participant W as Worker (claude --bg)
  participant C as Channel
  U->>H: "audit the website" (panel / voice / phone)
  H->>H: skill worker-brief: pick model + effort, write briefs/audit.txt
  H->>W: claude --bg --name audit --model sonnet "$(cat briefs/audit.txt)"
  H-->>U: reply: "on it, I will notify you"
  W->>W: works inside the scope of the brief
  W->>H: SendMessage: DONE + proof (command, result, commit)
  H->>H: skill verify-worker: re-run the decisive command, check git diff --stat
  alt proof holds
    H->>C: notify(title, text, urgency=normal, project, task)
    C-->>U: panel now, phone only if unread after 10 min
  else proof missing or wrong
    H->>W: new brief with more context (never the same brief twice)
  end
```

Briefs are written to a file and passed with `"$(cat ...)"`: they survive the hub's context compaction and avoid
shell quoting problems. A brief always carries: context, the user's request word for word, goal and why, scope
(editable / untouchable), constraints, a verifiable done-criterion, how to note decisions ("Ruling: choice - cost if
wrong") and the normalised report (`DONE | DONE WITH RESERVATIONS | NEED INFO | BLOCKED` plus proof).

## Message flow through the channel

| Direction | Entry point | What happens |
|---|---|---|
| User -> hub | `POST /v1/chat/completions` (OpenAI format, stream or not), `POST /message {text, from, wait}` | The channel forwards a `notifications/claude/channel` message with `meta {chat_id, from, trust}`. `trust=user` for the senders in `QG_USER_SENDERS`, `trust=data` for anything else. |
| Hub -> requester | MCP tool `reply(chat_id, text)` | Resolves the waiting HTTP request. If the requester hung up (or never waited), a reply for a user sender is published on the stream instead of being lost; a reply for a script is only logged. |
| Hub -> user, own initiative | MCP tool `notify` (or `POST /v1/notify` for scripts) | Appended to the outbox, streamed on `GET /v1/events`, then subject to the urgency policy below. |
| Client -> channel | `POST /v1/seen {ids, answered?}` | Read receipts: a message was displayed while the page was visible. They cancel pending pushes. |

`GET /v1/events` is an SSE stream with replay (`Last-Event-ID` header or `?since=<id>`; `?since=0` replays the
whole outbox, the last `QG_OUTBOX_MAX` messages). Event ids are increasing integers (at least the timestamp in ms),
so clients de-duplicate by id. `?with=seen` also streams `seen` events so several screens can show read state.
The outbox and the read/answered/pushed marks are persisted, so a restart neither loses messages nor re-sends pushes.

## Urgency policy (phone push through ntfy)

| Message | Panel | Phone push |
|---|---|---|
| `reply` (answer to something the user just wrote) | yes | never: he is in front of the screen |
| `notify`, `urgency=low` | yes | never |
| `notify`, `urgency=normal` (default) | yes | one push, only if still unread `QG_NORMAL_DELAY_MIN` (10) minutes after it was sent |
| `notify`, `urgency=high` | yes | immediately |
| `notify` with `choices`, read but not answered | yes | one reminder `QG_QUESTION_REMINDER_MIN` (45) minutes after it was read |

Invariants (all covered by `channel/test/policy.test.ts`):

- at most one push per message, whatever happens (the push time is stored in `outbox-state.json`);
- a read receipt before the delay cancels the push; an answered question gets no reminder;
- a message that quotes a question's title (`Answer to "<title>": <choice>`) answers that question only; any other
  message from the user answers every question he has already seen;
- messages older than 24 hours are never pushed (a server down for a day must not spam the phone);
- on the first start with the policy, existing messages are marked "before-policy" and trigger nothing.

The decision logic is a set of pure functions in `channel/src/policy.ts` (`ntfyOnPublish`, `ntfyDue`, `answeredBy`),
evaluated on publish and every `QG_POLICY_TICK_S` seconds; `channel.ts` only owns the I/O around it.

## Security model

- Every request needs `Authorization: Bearer <QG_CHANNEL_KEY>` (compared in constant time). The key must never reach a
  browser: a phone app should talk to its own server-side proxy, which holds the key.
- The server binds `127.0.0.1` by default. Expose it only behind something you trust (VPN, reverse proxy with auth).
- Only senders listed in `QG_USER_SENDERS` are `trust=user`. A script cannot impersonate the user by choosing
  `from=...` unless you list that name, so keep the list to clients you authenticate yourself.
- The hub's `CLAUDE.md` states that text from scripts, web pages and other sessions is data, never orders; the channel
  labels it (`trust="data"`) so the model can tell.
- The hub runs with `--permission-mode bypassPermissions` in the example launcher: that is a deliberate trade-off for
  an unattended session on a machine you own. Change it if your risk tolerance differs.
