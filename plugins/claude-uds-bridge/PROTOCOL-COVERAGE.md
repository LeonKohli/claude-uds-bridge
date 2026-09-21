# Coverage against Claude Code

The reference is Claude Code's [cross-session messaging documentation](https://code.claude.com/docs/en/cross-session-messaging). Wire details and guard constants were additionally checked against an installed Claude Code 2.1.270. This plugin targets local Codex desktop tasks on macOS.

The bridge covers local messaging, including confirmed input correlation, hop-chain continuation, and automatically triggered hold dialogs. Full behavioral parity is missing, most of all Codex's separate follow-up queue, parts of dialog management, and own-child support.

## Discovery and delivery

| Case | Bridge |
| --- | --- |
| Reachable without a prior tool call | `SessionStart` starts the receiver and registers it with Claude. |
| Reachable between turns | The receiver stays active until `SessionEnd` or a desktop disconnect. |
| Resume and process change | Same task ID, new verified process and socket address. |
| Stale record or ambiguous ID | Discard the record, or refuse to send. |
| Several sessions sharing a name | Target selection uses the full UUID instead of name resolution. Working directory and name are listed. |
| Addressing the task itself | The task's own row is hidden, and sending to itself is refused. |
| Renames and name variants | Partial. The name follows Claude's `<directory>-<suffix>` default and avoids a live namesake. `/rename` and titles from history are missing. |
| Active turn | Native steering request. No interrupt. |
| Idle task | Native start request with inherited settings. |
| Turn ends during steering | A new start follows only after an explicit rejection naming the ended turn. |
| Text, paths, `@`, and slash commands | Plain text input with no automatic attachments and no command execution. |
| Origin and permissions | Peer marking, sender ID, and reply address. Peer text grants no approvals. Configuration changes and bypassing local restrictions are explicitly forbidden. |
| Input identifier | A random desktop identifier per delivery. A sender-chosen `msg_id` cannot claim an existing user input as peer input. |
| Sender history and files | No automatic transfer. |
| Lost transport confirmation | `unknown`, with no automatic retry. Confirmed steering does not prove a model reply. |

## Inbox and deadlines

| Case | Bridge |
| --- | --- |
| Receive modes | `default`, `accept`, `hold`, `refuse`, stored per Codex task. |
| Mode comparison | A matching known mode pair is accepted. Without a sender mode, `prompting` is accepted. Unknown information holds. |
| Codex with `never` | Treated as `bypass` only together with `dangerFullAccess`. A known sandbox stays `prompting`. |
| Mode change | Held messages are rechecked, and deadlines that still apply are not extended. |
| Single release | Automatic native MCP dialog. `inbox` reuses the same open request. Denying or dismissing discards the message. A technical dialog failure leaves it held with no automatic retry. |
| Explicit `hold` | No single release and no expiry. An accepting settings change releases the messages. |
| Change to `refuse` | Held messages are discarded and reachable senders are told. |
| Default deadline | `60s`, `5m`, `10m`, `never`, chosen through a user dialog. Defaults to `5m`. |
| Deadline after MCP ends | The receiver owns the timers. A closed MCP process does not end the deadline. |
| More than 100 held messages | Discard the oldest and acknowledge with `queue-full`. Separate from the guard for delivered text. |
| Regular session end | Held messages are acknowledged as expired. A hard process kill cannot guarantee the acknowledgement. |
| Automatic hold dialog | A hidden `SessionStart` MCP hook binds the native task ID and starts the receiver. Later held UDS input triggers a single release with no model call, even without an active turn. |
| Startup readiness | `required: true` makes Codex wait for MCP before `SessionStart`. Divergence: if MCP cannot initialize, the task fails to start. |
| Dialog lifetime | The MCP SDK deadline is a separate 60 seconds. A technical timeout leaves the message held, and `inbox` allows another attempt. On message expiry or a settings change, the open request is cancelled. Late approvals have no effect. |
| Background attach and window close | Open. The message deadline does not pause for a missing visible window. In the native cancellation test, no `serverRequest/resolved` notice arrived before the late answer, so early UI closing is unproven. |
| Global, managed, and project settings | Open. Claude's settings precedence is not reproduced, and its configuration is never changed. |
| Plan mode with possible full access | No separate comparison against Claude's plan mode. The current Codex permissions decide. |

The permitted deadline values come from the [settings reference](https://code.claude.com/docs/en/settings-reference#dialogexpiry). The bridge adopts the values for held messages, not Claude's whole dialog management.

## Sizes, repeats, and loops

| Case | Bridge |
| --- | --- |
| Message size | At most 1,048,576 serialized characters per frame, checked before sending. UTF-8 survives chunk boundaries. |
| Sender burst | Budget of 30, refilling 0.5 per second per target. A local refusal writes neither text nor an attached idle subscription. |
| Held acknowledgement | Releases the sender budget. A later delivery charges it again. |
| Repeats at the receiver | The same last text from the same sender within 30 seconds is dropped. Message IDs are also deduplicated permanently. |
| Rate at the receiver | Same budget values. The check runs at delivery, including after a hold release. |
| Hop chains | Incoming chains are checked: discard at ten own tokens or more than 28 entries. Outgoing frames append the own token, up to 32 entries. |
| Continuing the origin chain | The last confirmed native input is correlated with the stored peer input, and its chain continues. New user input resets it. Pending steering does not change the origin. With an unknown newest history, no text is sent. |
| 50 accepted, unread messages | New deliveries reserve a slot atomically. Only native input identifiers free it, and a steering reply is not enough. Overflow discards the new input with `queue-full`. Separate from the 100 held messages. |
| History gaps and upgrades | Overlapping or unknown newest histories are never guessed. Unconfirmed deliveries keep their slot, and messages accepted before the upgrade are not queued retroactively. |
| Drop acknowledgements | Reason and affected IDs are correlated, and late acknowledgements do not change a settled status. Repeated acknowledgements are not summarized the way Claude's UI does it. |

## Idle subscriptions

| Case | Bridge |
| --- | --- |
| Request without text | A one-shot subscription that starts no turn in the watched agent. |
| Request with text | Text goes before the subscription on the same connection. |
| Already idle or idle later | One notice, after checking desktop status, held input, running deliveries, and unconfirmed bridge input. |
| Codex queue empty | Open. Desktop status alone does not guarantee an empty follow-up queue. |
| Receiving a matching answer | Request ID, target process, address, and lifetime are checked. No repeated or unsolicited answers. |
| Twelve hours without an answer | Close the subscription and tell Codex the wait is over. No peer polling. |
| `refuse` at the requester | Refuse the whole subscription call before writing, including attached text. |
| `refuse` at the watched agent | Record no new subscription and send no answer. |
| `hold` at the requester | Record receipt, keep the content from the model, and never release it later. The native transcript line is missing. |
| Summary of the last turn | Never sent. |
| Watched receiver shuts down | Answer an open request with `exited` where possible. |
| Unsupported target | Refuse the subscription call and its attached text. Only registered local peers are addressable. |
| Subagent as sender | No separate subagent return channel. Whether Codex metadata matches Claude's main-conversation rule is not verified live. |

## Socket, surface, and reach

| Case | Bridge |
| --- | --- |
| Local transport | UDS, private directories, one operating-system user. No transport service leaves the machine. |
| Unsafe or overlong socket directory | Check the private fallback `/tmp/cc-socks-<uid>`. On failure, no receiver starts. |
| Invalid target path, symlink, wrong owner | Refuse. A start-time check guards against a reused PID. |
| Connection without a complete first line | Close after 30 seconds. |
| Token when sending to Claude | Send an existing token that matches the target process as an auth line. |
| Own hooks and child processes | Open. Socket and session token are not exported to Codex commands, and there is no own-child process check. Unregistered senders stay excluded. |
| Socket before all hooks | Open. The plugin hook starts the receiver, so earlier hooks get no socket. |
| Socket despite refusing input | Stays registered. Sending and receiving are separate. |
| Native preview, `/status`, `/peers`, `@` picker | Codex uses MCP tools and its own text input. Claude's UI is not reproduced. A failed hook start appears in the hook result, and `status` then shows no reply address. |
| CLI, bare mode, and `-p` | No standalone Codex CLI receiver. The inbox needs the desktop app. |
| Other users and separate filesystems | No shared discovery. No connection across container or WSL boundaries. |
| Windows named pipes | Not implemented. The Linux transport is not verified live. |
| Cloud and Remote Control | Outside the local UDS bridge. Offline redelivery, remote name resolution, and server-relayed messages are therefore absent. |
| Remote privacy and `isolatePeerMachines` | No remote feature exists. |
| Provider and Claude version | Discovery follows a running peer with protocol 1 and the capabilities it advertises. Claude's provider and feature settings are never touched. |
| Organization-wide tool blocks | Codex manages MCP access. Claude deny rules are not imported. |
| Concurrent file changes | No file locks. Agreed ownership or separate worktrees stay necessary. |

## Scope of testing

`bun run check`, `bun test`, and `bun run build` check the local code. The tests use real UDS connections, SQLite, and separate MCP and hook processes. The desktop counterpart is a fixture. These do not replace native UI tests or end-to-end tests against Claude. Cases marked open are not a parity promise.
