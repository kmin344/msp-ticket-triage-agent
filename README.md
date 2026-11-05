# MSP Ticket Triage Agent

[![CI](https://github.com/kmin344/msp-ticket-triage-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/kmin344/msp-ticket-triage-agent/actions/workflows/ci.yml)

Fastify webhook → HMAC check → idempotency claim → Claude tool-use loop → Postgres, with every tool call audited.

## Run

```bash
cp .env.example .env          # set WEBHOOK_SECRET and ANTHROPIC_API_KEY
npm install
npm run db:up                 # Postgres 16; db/schema.sql runs on first start
npm run dev
```

## Send a ticket

```bash
BODY='{"customer_email":"ops@acme.example","subject":"Internet down","body":"No PC at reception can browse since 9am."}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | awk '{print $NF}')
curl -s localhost:3000/webhooks/ticket \
  -H 'content-type: application/json' \
  -H "x-signature: sha256=$SIG" \
  -H "x-idempotency-key: $(uuidgen)" \
  -d "$BODY"
```

Responses:

| Code | When | Body |
|------|------|------|
| `200` | New ticket, triaged | `{ticket_id, replayed: false, status: "completed", result, toolCalls}` |
| `200` | New ticket, handed to a human | `{ticket_id, replayed: false, status: "escalated", escalation_code, toolCalls}` |
| `200` | New ticket, triaged, but the model set `needs_human: true` | `{ticket_id, replayed: false, status: "completed", result, toolCalls}`; the ticket is stored with `escalation_code: "model_flagged"` |
| `200` | Replay of a finished request | `{ticket_id, replayed: true, ticket: {status, priority, category, summary, needs_human, escalation_code}}`, header `idempotent-replayed: true` |
| `400` | Bad payload or missing `x-idempotency-key` | |
| `401` | Bad signature | |
| `409` | Same key while the original request is still running | `{error, ticket_id}`, header `retry-after` |
| `422` | Same key with a different body | |
| `503` | Database unavailable | `{error: "service temporarily unavailable"}`, header `retry-after: 5` |

### Escalation codes

`escalation_code` is a stable public value, stored on `tickets` (enforced by a CHECK constraint) and returned to callers.

| Code | Meaning |
|------|---------|
| `llm_unavailable` | The model API call failed (overloaded, 5xx, network, auth) |
| `timeout` | The per-request deadline (`REQUEST_TIMEOUT_MS`) expired |
| `schema_invalid` | The final answer failed schema validation twice |
| `tool_limit` | The model asked for more than `MAX_TOOL_CALLS` tool calls |
| `model_flagged` | Valid final answer with `needs_human: true` |
| `model_escalated` | The model called `escalate_to_human` itself |
| `abandoned` | The original request died before finishing; escalated on a later replay |
| `agent_error` | Any other unexpected failure in the agent loop |

## Test

```bash
npm test        # in-memory repo + scripted fake model: no Postgres, no API key
npm run typecheck
```

## Design notes

**Request handling**
- The signature is checked over the raw body bytes, before the idempotency key is claimed, so forged requests can't burn keys.
- The key and the intake ticket are inserted in one transaction, so a key never exists without its ticket. The idempotency row
  stores the ticket id and a SHA-256 of the raw body.

**Replay semantics** (same `x-idempotency-key`, valid signature)
- Same body, original finished → `200` with `replayed: true` and the ticket's current state. The agent is never run twice for one key.
- Same body, original still running (ticket status `received`) → `409` with the `ticket_id` and `retry-after`; retry later.
- Same body, original died before finishing (crash or DB outage mid-triage) → the ticket stays `received`. Once it is older than
  `2 × REQUEST_TIMEOUT_MS + 10 s`, the next replay escalates it (`abandoned`) and returns `200`. The update is atomic and uses
  the database clock, so only one concurrent retry performs it.
- Different body → `422`; the key is bound to its first payload.
- Database unreachable at any point → `503` with a generic body; the driver error is logged, never returned.

**What callers see vs. what operators see**
- Responses and the `tickets` table carry only `escalation_code`. Raw upstream error text (e.g. provider error messages) and the
  model's free-text escalation reason, which can echo untrusted ticket content, are written only to `audit_log.input.detail`
  and the server log.
- Responses are built field by field rather than spreading internal objects, so new internal fields can't leak by accident.

**Agent**
- The agent stops and escalates on: an LLM error, timeout, 2 invalid final answers, or more than `MAX_TOOL_CALLS` tool calls.
  Database errors inside the loop are not escalated (that would fail too); they surface as `503`.
- Tools are bound to a single ticket id, and their inputs are validated with zod before touching the database.
- The ticket body is untrusted input and is wrapped in `<ticket_body>` in the prompt; the model can only act through the three tools.

## How this was built

I wrote the spec (stack, failure handling, test cases) and built the code with Claude in one conversation, iterating over four rounds: initial build → I ran it against a real Postgres 16 and reported three bugs (replay returned a bare 409, DB errors leaked host/port, key claim and ticket insert were not atomic) → fixes verified locally (20 concurrent same-key requests produce exactly one ticket) → a fourth bug (raw LLM error text leaking through `escalation_reason`) fixed with stable escalation codes. Final state: `tsc` clean, 14/14 vitest tests, Postgres scenarios re-run locally.

## License

[GPL-3.0](LICENSE)
