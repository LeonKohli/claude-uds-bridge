# Parity with Claude Code

This file compares the bridge with Claude Code's cross-session messaging. Sources:

- [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) and the [settings reference](https://code.claude.com/docs/en/settings-reference).
- The installed Claude Code 2.1.288 binary, for frame handlers.
- [PeterSR's socket protocol notes](https://github.com/PeterSR/claude-code-socket-transport/tree/480bd83c0bf1c63161c5afdb0976bbff849c926b), which describe 2.1.233.
- The Codex `rust-v0.159.2` source.

A live check against a real Claude peer last ran on 2.1.285. The wire format is a Claude internal with no compatibility promise.

In the tables, `yes` means implemented, `partial` means some of the behavior, `no` means missing, and `n/a` means outside a local bridge. The Test column names the file in `test/` that covers the row. `none` means no test.

## Wire contract

A registry row `$CLAUDE_CONFIG_DIR/sessions/<pid>.json` holds the PID, `sessionId`, name, status, protocol version, `messagingSocketPath`, and capabilities. The filename must match the recorded PID. The socket basename is free: Claude falls back to `<pid>-<8-hex>.sock` or random hex on a collision and accepts an explicit path. The bridge honors the recorded path. It accepts protocol 1 and checks the process start time, socket owner, private directory, and socket type. Trust is same-user: the bridge does not read kernel peer credentials.

The socket carries newline-delimited UTF-8 JSON, at most 1,048,576 characters per line. `from` is `uds:` plus the socket path, with every byte outside `[A-Za-z0-9:_/.\\-]` percent-encoded in uppercase. The registry keeps the raw path.

| Frame | Fields | Bridge |
| --- | --- | --- |
| `auth` line | `token` | The bridge sends it first when a peer key file matches the target process, and ignores it on receive. |
| `user` | `msgV: 1`, UUID `msg_id`, `from`, `message: {role, content}`; optional `session_id`, `priority`, `uuid`, `file_attachments` | Sends `session_id` and `priority: "next"`. Accepts `now`, `next`, and `later` and treats all three as `next`, because the bridge has no separate ordering lane. Drops a frame for another `session_id`. Ignores `uuid`. Refuses nonempty `file_attachments`. |
| `control` `notify_when_idle` | UUID `msg_id`, optional `from_mode`, optional `session_id` | Requests one idle notice. |
| `control` `peer_idle_notice` | `orig_msg_id`, `state`; optional `msg_id`, `finished_at`, `detail`, `from_mode`, `session_id` | The bridge delivers it once, if it matches a request. |
| `control` `peer_message_status` | `orig_msg_id`, `status`; optional `reason`, `status_detail`, `drop_reason`, up to 256 `dropped_msg_ids`, `session_id` | The bridge keeps it in status and stores `reason` as `status_reason`. |
| `control` `rename` | `name` | The bridge drops the frame. |
| `control` `yield_artifact_replies`, `unyield_artifact_replies`, `artifact_replies_yielded` | Artifact comment handoff | The bridge drops these frames and does not advertise `artifact_yield`. |

A text envelope looks like this. Claude checks attribute order and serialization.

```text
<cross-session-message from="uds:/path/123.sock" from-session="sender-uuid" hop-chain="24-hex-token" from-name="registered-name" from-mode="prompting">
message text
</cross-session-message>
```

`hop-chain` and `from-mode` are optional. A closing tag inside the body is escaped. `from-session` names the sending conversation. The outer `session_id` names the recipient. Neither grants approval.

Receipt statuses:

- `held`: deferred.
- `denied`: rejected by the receiving user.
- `expired`: the deadline ended. With `status_detail: "refused"` it means refused.
- `dropped`: a guard dropped it, with a reason.
- `delivered`: a held message was released. Ordinary acceptance sends no receipt.

A socket write and a receipt are both separate from a model reply.

## Parity

### Discovery

| Case | State | Note | Test |
| --- | --- | --- | --- |
| Reachable without a manual tool call | yes | `SessionStart` on the first turn registers the receiver. | app-server, native |
| Untouched chat, Claude starts the first turn | no | Codex runs `SessionStart` inside the first turn. See [STARTUP.md](STARTUP.md). | native `--peer-first` |
| Resume or process change | yes | The task keeps its ID and gets a new verified process and socket. | hook |
| Stale record, ambiguous ID | yes | The bridge discards the record or refuses the send. | trust, bridge |
| Collision recovery, explicit socket path | yes | The recorded path is used. | trust |
| Names | partial | `codex-<directory>-<suffix>`, lengthened when a live peer holds the name. A long Codex folder name keeps its first and last part. Missing: `/rename`, `--name`, `nameSource`, `rename` frame. | protocol |
| Registry fields | partial | The row carries `status`. `tempo`, `state`, `detail`, `needs`, and `waitingFor` are not written. | none |
| Same name, several sessions | yes | Sending uses the full UUID. | protocol |
| Own row, send to self | yes | The row is hidden and the send refused. | protocol |
| Capability `notify_idle` | yes | | protocol |
| Capabilities `reply_across_default_dirs`, `artifact_yield` | no | The first needs peer process evidence that regular Bun cannot provide. The second needs an Artifact watcher. | none |

### Delivery

| Case | State | Note | Test |
| --- | --- | --- | --- |
| Active turn | yes | Sends a steering request and never interrupts. | app-server, desktop |
| Idle task | yes | Starts a turn with inherited settings. | app-server |
| Turn ends during steering | yes | App-server decides atomically. Desktop IPC starts a turn only after an explicit rejection. | desktop |
| Plain text, no commands, no automatic attachments | yes | | protocol |
| Attachments and `SendFile` | no | The bridge refuses nonempty `file_attachments` with a reason. Claude gates `SendFile` on `tengu_send_file`, default off. | protocol |
| Origin and permissions | yes | Peer marking, `from-session`, reply address. Peer text grants no approval. | protocol |
| Input ID | yes | Random per delivery. A sender cannot claim an existing user input through `msg_id`. | protocol |
| Lost confirmation | yes | `unknown`, no retry. `accepted` does not prove a reply. | desktop |
| `priority` `now` and `later` | yes | Accepted and handled as `next`. Claude's own sender uses `next`. | protocol |
| `session_id` on any frame | yes | A frame for another session is dropped, text or control. Claude's own control frames carry no `session_id`. | protocol |
| Session ID change after `/clear` | yes | Per PeterSR and Claude's `regenerateSessionId`, a Claude process keeps its PID and start time and gets a new `sessionId`. Stored sends, idle requests, and receipts resolve by socket address and start time. Not reproduced against a live Claude. | protocol |

### Inbox and deadlines

| Case | State | Note | Test |
| --- | --- | --- | --- |
| Receive modes | yes | `default`, `accept`, `hold`, `refuse`, stored per task. | protocol |
| Permission class | yes | A known matching pair is accepted. Without a sender mode, `prompting` is accepted. Unknown holds. Codex `never` counts as `bypass` only with `dangerFullAccess`. | protocol, desktop |
| Plan mode with bypass available | no | The current Codex permissions decide. | none |
| Settings files, precedence, `CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS` | no | The policy is per task. | none |
| Release dialog | yes | Opens automatically, also between turns. `inbox` reuses the open request. Deny or dismiss discards. A dialog failure leaves the message held. | protocol |
| Mode change | yes | The bridge rechecks held messages and does not extend deadlines. | protocol |
| Change to `refuse` | yes | The bridge discards held messages and tells reachable senders. | protocol |
| Explicit `hold` | yes | No expiry. An accepting change releases. | protocol |
| Deadline values | yes | `60s`, `5m`, `10m`, `never`, default `5m`. | protocol |
| Timers after MCP exits | yes | The receiver owns them. | protocol |
| Dialog lifetime | yes | The MCP SDK's default request timeout of 60 seconds applies. A timeout leaves the message held. Expiry or a settings change cancels the request. | protocol |
| Deadline pause without a window | no | Codex gives no trusted attachment signal. | none |
| More than 100 held | yes | The bridge drops the oldest with `queue-full`. | protocol |
| Session end | yes | The bridge acknowledges held messages as expired. A hard kill cannot guarantee it. | protocol |
| Startup readiness | partial | `required: true` makes Codex wait for MCP before `SessionStart`. If MCP cannot start, the task fails to start. | native |

### Limits and loops

| Case | State | Note | Test |
| --- | --- | --- | --- |
| Message size | yes | Serialized characters, checked before sending. UTF-8 survives chunking. | protocol |
| Sender burst | yes | 30, refilling 0.5 per second per target. A refusal writes no text and no subscription. A held receipt releases the budget. | protocol, guard |
| Receiver repeats | yes | The same last text from one sender within 30 seconds is dropped. IDs are deduplicated permanently. | protocol |
| Receiver rate | yes | Same budget, checked at delivery and at hold release. | protocol |
| Hop chains | yes | Discard at ten own tokens or more than 28 entries. Outgoing frames append the own token, up to 32. The chain continues from the last confirmed peer input and resets on user input. | protocol, app-server, desktop |
| 50 unread accepted | yes | Only a native input ID frees a slot. Overflow drops with `queue-full`. | protocol |
| Receipt handling | partial | The bridge correlates reason, drop reason, and IDs, and ignores late receipts. Repeated receipts are not summarized. | protocol |

### Idle subscriptions

| Case | State | Note | Test |
| --- | --- | --- | --- |
| Request, with or without text | yes | Text goes first on the same connection. | protocol |
| Notice | yes | One, after checking status, held input, running deliveries, and unconfirmed bridge input. A matching request ID, process, address, and lifetime are required. | protocol |
| Codex queue empty | partial | App-server checks `thread/queue/list`. Desktop status alone does not prove an empty queue. | app-server |
| Twelve hours without an answer | yes | The bridge closes the subscription and tells Codex. | protocol |
| `refuse` at requester or watched agent | yes | The requester refuses the whole call. The watched agent records nothing. | protocol |
| `hold` at requester | partial | The bridge records the receipt and keeps the content from the model. The transcript line is missing. | protocol |
| Summary of the last turn | no | Notices carry status and time only. | none |
| Watched receiver exits | yes | The bridge answers an open request with `exited`. | protocol |
| Subagent as sender | no | No subagent return channel. Not verified against Claude's rule. | none |

### Socket and reach

| Case | State | Note | Test |
| --- | --- | --- | --- |
| Private socket directory | yes | Fallback `/tmp/cc-socks-<uid>`. No receiver starts if both fail. The path limit is 103 bytes and has no test. | hook |
| Wrong owner, symlink, other-user access | yes | The bridge refuses. A start-time check guards against PID reuse. | trust |
| Silent connection | yes | The bridge closes it after 30 seconds. | none |
| Auth line | partial | Sent to Claude when a matching key file exists. Ignored on receive, so the sender class comes from the registry and `from-mode`. | protocol |
| Own-child messages, `CLAUDE_CODE_MESSAGING_SOCKET` and `_TOKEN` exports | no | Commands of a Codex task cannot post to their own session as verified children. | none |
| Socket before all hooks | no | The plugin hook starts the receiver, so earlier hooks get no socket. | none |
| Receiving refused | yes | The socket stays registered. | protocol |
| Codex CLI and `-p` | partial | CLI on the shared daemon works. `--no-daemon` has no receiver. | app-server |
| Native UI: preview, `/status`, `/peers`, `@` picker, transcript rows | no | Codex uses MCP tools. | none |
| Other users, containers, WSL boundaries | n/a | No shared discovery. | |
| Windows, cloud, Remote Control, `isolatePeerMachines` | n/a | | |
| File locks | n/a | None. Agree on ownership or use separate worktrees. | |

## Testing

`bun run check`, `bun test`, and `bun run build` check the local code. The tests use real Unix sockets, SQLite, and separate MCP and hook processes. Fixtures cover app-server and desktop failures, input correlation, permissions, queues, and observer recovery.

`bun run test:native` starts the real Codex app-server in a temporary home with a local model stub. It verifies automatic `SessionStart`, idle and active delivery reaching the model, input consumption, an outbound reply, and `SessionEnd`. Set `CODEX_BRIDGE_TEST_BINARY` to test another Codex binary. Set `UDS_MCP_TEST_ENTRYPOINT` and `UDS_HOOK_TEST_ENTRYPOINT` to absolute bundle paths to test the built plugin.

- `--peer-first` and `--interactive` open an untouched chat and check that no model request happens and no receiver exists. They then start the first turn with an explicit backend request. This shows the startup boundary, not discovery by Claude.
- `<claude-session-uuid>` (from `list_sessions`) sends test prompts to that real Claude, asks for two replies, and checks the idle notice. It uses Claude's model service and removes its own receiver and temporary home afterward.

Verified: native runs on Codex 0.159.0, 0.159.2, and 0.159.3, the live Claude run on 2.1.285, CI on macOS and Linux.

Not verified:

- A live Claude run on 2.1.288.
- The native Codex desktop UI, and early closing of the release dialog (no `serverRequest/resolved` arrived before a late answer).
