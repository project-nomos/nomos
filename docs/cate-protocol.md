# CATE Protocol Integration

Nomos integrates the CATE (Consumer Agent Trust Envelope) protocol for secure, trust-aware agent-to-agent communication.

## Overview

CATE is a transport-agnostic envelope format that wraps any agent-to-agent message with identity verification (DIDs + Verifiable Credentials), policy enforcement, rate limiting, and optional stamps (proof-of-work or micropayment). Nomos is the first consumer of the `@project-nomos/cate-sdk`.

## Architecture

```
External Agent                    Nomos Daemon
     |                                 |
     |  POST /cate (CATE envelope)     |
     |-------------------------------->|
     |                                 |  NomosTransport (HTTP)
     |                                 |  --> CATEServer
     |                                 |      - Verify DID
     |                                 |      - Evaluate policy
     |                                 |      - Check rate limits
     |                                 |      - Verify stamps
     |                                 |  --> Message Queue
     |                                 |  --> Agent Runtime
     |  {"status": "accepted"}         |
     |<--------------------------------|
```

## Components

### NomosKeystore (`src/cate/nomos-keystore.ts`)

Implements the `@project-nomos/cate-sdk` Keystore interface using Node.js native `crypto` module for Ed25519 operations. Keys are stored encrypted in the `integrations` table via AES-256-GCM.

- Key IDs: `nomos-agent` (agent's DID key), `nomos-user` (user's DID key for VC issuance)
- DER encoding with hardcoded PKCS8/SPKI headers for Ed25519

### NomosTransport (`src/cate/nomos-transport.ts`)

HTTP transport that extends the SDK's abstract `Transport` class:

- **Inbound:** HTTP server on port 8801, accepts POST at `/cate`
- **Outbound:** Sends envelopes via `fetch()` to peer endpoints

### Integration (`src/cate/integration.ts`)

Orchestrates CATE setup on daemon startup:

1. Creates or loads agent DID from keystore
2. Issues "acts-for" Verifiable Credential (agent acts on behalf of user)
3. Creates signed Agent Card (A2A-compatible)
4. Loads policy configuration from DB
5. Starts CATEServer

## Default Policy

The default policy (configurable via `app.catePolicyConfig` in DB):

| Intent               | Action           | Description                                        |
| -------------------- | ---------------- | -------------------------------------------------- |
| `personal`, `system` | Allow            | Personal and system messages pass through          |
| `transactional`      | Require approval | User must approve transactional messages           |
| `promotional`        | Require stamp    | PoW stamp (difficulty 20) or micropayment required |

## Configuration

| DB Key                 | Description                             |
| ---------------------- | --------------------------------------- |
| `app.catePolicyConfig` | JSON policy config (rules, rate limits) |
| `app.agentName`        | Agent name shown in Agent Card          |

## DID and Identity

On first startup, CATE generates two Ed25519 key pairs:

- **Agent DID** (`did:key:z6Mk...`) — The agent's decentralized identifier
- **User DID** — The user's identifier, used to issue "acts-for" VCs

The agent's DID is logged at startup:

```
[cate] Server started on port 8801 (DID: did:key:z6Mk...)
```

## CATE Protocol SDK

The standalone library lives at `@project-nomos/cate-sdk` with subpath exports:

- `@project-nomos/cate-sdk` — Client, Server, main exports
- `@project-nomos/cate-sdk/types` — Zod schemas for envelope, DID, stamps, policy
- `@project-nomos/cate-sdk/identity` — DID resolution, VC issuance, Agent Cards, Keystore
- `@project-nomos/cate-sdk/stamps` — PoW and micropayment stamps
- `@project-nomos/cate-sdk/policy` — Policy engine, intent classifier, consent, rate limiter
- `@project-nomos/cate-sdk/transport` — Abstract transport + HTTP reference implementation
- `@project-nomos/cate-sdk/adapters` — A2A and MCP bridge adapters

## Testing

Send a test envelope to the running daemon:

```bash
curl -X POST http://localhost:8801/cate \
  -H "Content-Type: application/json" \
  -d '{
    "header": {
      "msg_id": "test-001",
      "created_at": "2026-04-07T00:00:00Z",
      "sender": {"did": "did:key:z6MkTest"},
      "recipient": {"did": "did:key:z6MkTest2"}
    },
    "policy": {"intent": "personal"},
    "payload": {"content": "Hello from a test agent"}
  }'
```

Expected: `{"status":"accepted"}` (200 OK)
