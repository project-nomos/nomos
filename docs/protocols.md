# Client Protocols

Nomos exposes two server protocols for client communication, plus the built-in terminal REPL and a web-based settings UI.

## Connection Points

| Protocol           | Port | Purpose                                                 |
| ------------------ | ---- | ------------------------------------------------------- |
| **gRPC**           | 8766 | Primary protocol for CLI, web, and mobile clients       |
| **WebSocket**      | 8765 | Legacy protocol (maintained for backward compatibility) |
| **Ink CLI**        | —    | Interactive terminal REPL with streaming markdown       |
| **Next.js Web UI** | 3456 | Settings dashboard and management interface             |

## gRPC (Primary)

Clients communicate via gRPC on `localhost:8766`. The service is defined in [`proto/nomos.proto`](../proto/nomos.proto).

```protobuf
service NomosAgent {
  rpc Chat (ChatRequest) returns (stream AgentEvent);
  rpc Command (CommandRequest) returns (CommandResponse);
  rpc GetStatus (Empty) returns (StatusResponse);
  rpc ListSessions (Empty) returns (SessionList);
  rpc GetSession (SessionRequest) returns (SessionResponse);
  rpc ListDrafts (Empty) returns (DraftList);
  rpc ApproveDraft (DraftAction) returns (DraftResponse);
  rpc RejectDraft (DraftAction) returns (DraftResponse);
  rpc Ping (Empty) returns (PongResponse);
}
```

The `.proto` file can generate native clients for iOS (Swift), Android (Kotlin), and other platforms.

### Chat RPC

`Chat` is a server-streaming RPC. The client sends a `ChatRequest` with the message text and session key, and receives a stream of `AgentEvent` messages as the agent processes the request. Events include text deltas, tool use notifications, and completion signals.

### Command RPC

`Command` handles slash-command style operations (model switching, memory search, config changes) without starting a full agent session.

## WebSocket (Legacy)

The WebSocket server runs on `ws://localhost:8765` for backwards compatibility. New client features should use gRPC instead. See the [protocol documentation](websocket-protocol.md) for message formats.

### Connection Flow

1. Client connects to `ws://localhost:8765`
2. Server sends a `connected` event with the session ID
3. Client sends messages as JSON `{ type: "message", text: "...", sessionKey: "..." }`
4. Server streams agent events back as JSON

## Terminal REPL

The built-in Ink-based REPL (`nomos chat`) connects to the daemon via gRPC if it's running, or runs the agent SDK in-process if not. Features include streaming markdown rendering, gradient spinner, and Catppuccin Mocha theme.

## Settings Web UI

A Next.js app at `settings/` serves a browser-based management interface on port 3456. It starts automatically with the daemon or can run standalone via `nomos settings`.

| Route             | Description                                                                     |
| ----------------- | ------------------------------------------------------------------------------- |
| `/setup`          | 5-step onboarding wizard (database, API, personality, channels, ready)          |
| `/dashboard`      | Overview: assistant status, model, active channels, memory stats, quick actions |
| `/settings`       | Assistant identity, API config, model, advanced settings                        |
| `/integrations`   | Channel overview and per-platform configuration                                 |
| `/admin/database` | Database connection and migration status                                        |
| `/admin/memory`   | Memory store stats and management                                               |
| `/admin/costs`    | Session cost tracking and per-model usage breakdown                             |
| `/admin/context`  | Context window visualization with token budget breakdown                        |
