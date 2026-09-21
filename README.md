# Claude UDS Bridge

A Codex plugin that lets Codex tasks and Claude Code sessions message each other on one machine.

Claude Code can already list its other sessions and send one of them a message by name. This plugin registers your Codex task in the same local registry, so Claude finds the task with `ListAgents` and writes to it with `SendMessage`. No handshake, no tool call first. From the Codex side, a bundled MCP server lists the live agents and sends to one of them.

Messages travel over Unix domain sockets in a private per-user directory. Nothing reaches OpenAI or Anthropic servers.

## Requirements

- The Codex desktop app, running. Delivery goes through a task's IPC connection, so a CLI-only Codex has no inbox. This is the real platform constraint: the bridge runs wherever that app does.
- macOS or Linux. The transport uses POSIX sockets, and CI runs the suite on both. Windows named pipes are not implemented.
- Claude Code 2.1.224 or later, the first release with [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging).
- Bun on your `PATH`. The lifecycle hook and the MCP server both run under Bun.

## Install

Add the marketplace, then install the plugin:

```bash
codex plugin marketplace add LeonKohli/claude-uds-bridge
codex plugin add claude-uds-bridge@leonkohli
```

Codex ignores plugin hooks until you trust them. Open the plugin in Codex, review the two hooks, and confirm both. A task becomes reachable only when its `SessionStart` hook runs.

Open a new Codex task after confirming. Tasks that were already open keep running without the hooks.

To install from a local checkout, point the marketplace at the folder instead:

```bash
codex plugin marketplace add /path/to/claude-uds-bridge
codex plugin add claude-uds-bridge@leonkohli
```

## Check that it works

In the Codex task, ask for the bridge status. Codex calls the `status` tool and reports a `replyAddress`. A `null` address means the lifecycle hook did not run, so check the hook trust prompt first.

In Claude Code, run `/list-agents`. The Codex task appears under a name built from its working directory, such as `codex-ccurio-c6`. Ask Claude to message it, and the text arrives in the Codex task.

## How a message arrives

An incoming message steers the Codex task's active turn, or starts a new turn when the task is idle. A running tool keeps going and is never interrupted. This matches Claude Code's own [delivery between tool calls](https://code.claude.com/docs/en/cross-session-messaging#message-delivery).

Peer text is marked as external input. It grants no user permission, and the receiving agent's own permissions still apply.

## Naming

Claude's `ListAgents` shows the model only the name of each agent, and `SendMessage` addresses by that name alone. The bridge therefore follows Claude Code's own default of `<directory>-<suffix>` and prefixes it with `codex-`. Codex builds a task folder from the opening prompt, so a long folder name keeps its first and last part, where the distinguishing words sit. When a live peer already holds the name, the bridge lengthens the suffix. The same name travels in the message envelope as `from-name`, so a reply reaches the task that sent it.

In the other direction, `send_message` addresses by `sessionId` rather than by name, and an ambiguous registration is refused instead of guessed.

## Controlling what arrives

The receive setting belongs to one Codex task. On a permission-mode mismatch the bridge opens a native dialog, including between turns. Held text reaches the model only after you release it.

| Setting | Behavior |
| --- | --- |
| `default` | Accept a matching permission mode, hold a differing one. Without a sender mode, accept only `prompting`. |
| `accept` | Receive messages and release the held ones. |
| `hold` | Hold without expiry until an accepting setting applies or the session ends. |
| `refuse` | Drop messages and discard idle subscriptions. |

A message held by the mode comparison expires after five minutes by default. The `inbox` tool offers `60s`, `5m`, `10m`, and `never`. The sender receives Claude's status notices, including `held`, `delivered`, `denied`, and `expired`.

## MCP tools

| Tool | Use |
| --- | --- |
| `list_sessions` | List local agents with ID, name, kind, working directory, status, and start time, most recently started first. |
| `send_message` | Send text to one agent by `sessionId`. Set `notify_when_idle` for one notice when that agent next goes idle. |
| `status` | Show the receiver and recent transport outcomes. |
| `inbox` | Set the receive policy, set the hold expiry, or review the oldest held message. |

## Limits

- A serialized message may reach 1,048,576 characters. The sender refuses anything larger before writing.
- The sender refuses a message once a burst of 30 to one agent is exhausted. The budget grows by one message every two seconds.
- At most 100 messages stay held, and at most 50 accepted messages wait for Codex to take them up.
- `socket-written`, `started`, and `steered` report transport progress, not a model reply.
- Idle subscriptions fire once and last at most twelve hours.
- The bridge does not lock files. Agree on file ownership before two agents edit one repository.
- Delivery uses the internal Codex desktop IPC interface. An incompatible app version makes delivery fail as `unknown`.

[`plugins/claude-uds-bridge/PROTOCOL-COVERAGE.md`](plugins/claude-uds-bridge/PROTOCOL-COVERAGE.md) compares the implementation against Claude's documented behavior case by case, including the cases it does not cover.

## Development

```bash
cd plugins/claude-uds-bridge
bun install --frozen-lockfile
bun run check
bun test
bun run build
```

The plugin runs the bundled `dist/server.js` and `dist/hook.js`, so run `bun run build` after changing anything under `src/`. Dependencies are bundled, and no `node_modules` is needed at runtime.

The Claude transport follows the [socket protocol documented by PeterSR](https://github.com/PeterSR/claude-code-socket-transport/tree/480bd83c0bf1c63161c5afdb0976bbff849c926b). Delivery into Codex uses `thread-follower-steer-turn` and `thread-follower-start-turn` on the existing task and confirms through the returned turn ID.

## License

MIT. See [LICENSE](LICENSE).
