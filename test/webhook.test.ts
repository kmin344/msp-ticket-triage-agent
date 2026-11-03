import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Block, LlmClient } from '../src/agent.js';
import {
  ESCALATION_CODES,
  RepoError,
  type AuditEntry,
  type Customer,
  type EscalationCode,
  type Intake,
  type IntakeClaim,
  type Repo,
  type TicketSnapshot,
  type TriageFields,
} from '../src/db.js';
import { buildServer, type ServerDeps } from '../src/server.js';
import { sign } from '../src/signature.js';

const SECRET = 'test-secret-0123456789';

type StoredTicket = TicketSnapshot & Intake & { customer_id?: number; updatedAt: number };

class InMemoryRepo implements Repo {
  keys = new Map<string, { ticketId: number; requestHash: string }>();
  customers: Customer[] = [{ id: 1, email: 'ops@acme.example', name: 'Acme Dental', plan: 'premium' }];
  tickets = new Map<number, StoredTicket>();
  audit: AuditEntry[] = [];
  /** Simulates the database being unreachable: every call throws a RepoError. */
  down = false;

  private check(op: string) {
    if (this.down) throw new RepoError(op, new Error('connect ECONNREFUSED 127.0.0.1:5999'));
  }

  async beginIntake(key: string, requestHash: string, i: Intake): Promise<IntakeClaim> {
    this.check('beginIntake');
    const existing = this.keys.get(key);
    if (existing) return { kind: 'replay', ...existing };
    const id = this.tickets.size + 1;
    this.tickets.set(id, {
      ...i, id, status: 'received', priority: null, category: null, summary: null,
      needs_human: false, escalation_code: null, updatedAt: Date.now(),
    });
    this.keys.set(key, { ticketId: id, requestHash });
    return { kind: 'created', ticketId: id };
  }
  async getTicket(id: number): Promise<TicketSnapshot | null> {
    this.check('getTicket');
    const t = this.tickets.get(id);
    if (!t) return null;
    const { status, priority, category, summary, needs_human, escalation_code } = t;
    return { id, status, priority, category, summary, needs_human, escalation_code };
  }
  async escalateIfStale(id: number, staleAfterMs: number) {
    this.check('escalateIfStale');
    const t = this.tickets.get(id)!;
    if (t.status !== 'received' || Date.now() - t.updatedAt < staleAfterMs) return false;
    Object.assign(t, { status: 'needs_human', needs_human: true, escalation_code: 'abandoned', updatedAt: Date.now() });
    return true;
  }
  async findCustomerByEmail(email: string) {
    this.check('findCustomerByEmail');
    return this.customers.find((c) => c.email === email.toLowerCase()) ?? null;
  }
  async updateTicketTriage(id: number, f: TriageFields) {
    this.check('updateTicketTriage');
    const t = this.tickets.get(id)!;
    Object.assign(t, f, { status: t.needs_human ? 'needs_human' : 'triaged', updatedAt: Date.now() });
  }
  async markNeedsHuman(id: number, code: EscalationCode) {
    this.check('markNeedsHuman');
    Object.assign(this.tickets.get(id)!, { status: 'needs_human', needs_human: true, escalation_code: code, updatedAt: Date.now() });
  }
  async logAudit(e: AuditEntry) {
    this.check('logAudit');
    this.audit.push(e);
  }
  async close() {}
}

/** Replays a fixed script of model turns; no network, no API key. A turn may be an Error to throw. */
function fakeModel(turns: (Block[] | Error)[]): LlmClient & { calls: number } {
  const fake = {
    calls: 0,
    async complete() {
      const content = turns[fake.calls++];
      if (!content) throw new Error('fake model ran out of turns');
      if (content instanceof Error) throw content;
      const stop_reason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
      return { stop_reason, content };
    },
  };
  return fake;
}

const text = (t: string): Block[] => [{ type: 'text', text: t }];
const tool = (name: string, input: unknown, id = name): Block[] => [{ type: 'tool_use', id, name, input }];
const happyTurns = () => [
  tool('lookup_customer', { email: 'ops@acme.example' }),
  tool('create_ticket', { customer_id: 1, priority: 'P2', category: 'network', summary: 'Reception PCs offline' }),
  text('{"priority":"P2","category":"network","summary":"Reception PCs offline","needs_human":false}'),
];

const payload = JSON.stringify({
  customer_email: 'ops@acme.example',
  subject: 'Front desk PCs cannot reach the internet',
  body: 'Since 9am none of the reception computers can load any website.',
});

function setup(llm: LlmClient, opts: Partial<ServerDeps> = {}) {
  const repo = new InMemoryRepo();
  const app = buildServer({ repo, llm, webhookSecret: SECRET, requestTimeoutMs: 2_000, maxToolCalls: 5, ...opts });
  const post = (key: string, body = payload, signature = sign(SECRET, body)) =>
    app.inject({
      method: 'POST',
      url: '/webhooks/ticket',
      headers: { 'content-type': 'application/json', 'x-signature': signature, 'x-idempotency-key': key },
      payload: body,
    });
  return { repo, app, post };
}

describe('POST /webhooks/ticket', () => {
  let llm: ReturnType<typeof fakeModel>;

  beforeEach(() => {
    llm = fakeModel(happyTurns());
  });

  it('rejects a bad signature with 401 and does not consume the idempotency key', async () => {
    const { post, repo } = setup(llm);
    const res = await post('key-00000001', payload, sign('wrong-secret-xxxxxxxx', payload));
    expect(res.statusCode).toBe(401);
    expect(repo.keys.size).toBe(0);
    expect(llm.calls).toBe(0);
  });

  it('rejects a body tampered after signing with 401', async () => {
    const { post } = setup(llm);
    const res = await post('key-00000002', payload.replace('9am', '8am'), sign(SECRET, payload));
    expect(res.statusCode).toBe(401);
  });

  it('completes triage on the happy path and audits every tool call', async () => {
    const { post, repo } = setup(llm);
    const res = await post('key-happy-001');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ticket_id: 1, replayed: false, status: 'completed', result: { priority: 'P2' } });
    expect(repo.tickets.get(1)).toMatchObject({ customer_id: 1, priority: 'P2', status: 'triaged', needs_human: false });
    expect(repo.audit.map((a) => a.tool)).toEqual(['lookup_customer', 'create_ticket']);
    expect(repo.audit.every((a) => a.ticket_id === 1 && a.latency_ms >= 0)).toBe(true);
  });

  it('escalates to a human after two schema validation failures', async () => {
    const bad = fakeModel([
      tool('lookup_customer', { email: 'ops@acme.example' }),
      text('Looks like a network issue, probably P2.'),          // not JSON
      text('{"priority":"urgent","category":"network"}'),        // JSON, wrong shape
      text('{"priority":"P2","category":"network","summary":"never reached","needs_human":false}'),
    ]);
    const { post, repo } = setup(bad);
    const res = await post('key-schema-01');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ticket_id: 1, replayed: false, status: 'escalated', escalation_code: 'schema_invalid', toolCalls: 1 });
    expect(bad.calls).toBe(3); // the valid 4th turn is never requested
    expect(repo.tickets.get(1)).toMatchObject({ needs_human: true, escalation_code: 'schema_invalid' });
    expect(repo.audit.at(-1)).toMatchObject({ tool: 'escalate_to_human', input: { source: 'system', code: 'schema_invalid' } });
  });

  it('escalates when the tool-call cap is exceeded', async () => {
    const loop = fakeModel(Array.from({ length: 10 }, (_, i) => tool('lookup_customer', { email: 'ops@acme.example' }, `t${i}`)));
    const { post, repo } = setup(loop);
    const res = await post('key-cap-00001');
    expect(res.json()).toMatchObject({ status: 'escalated', escalation_code: 'tool_limit', toolCalls: 5 });
    expect(repo.audit.filter((a) => a.tool === 'lookup_customer')).toHaveLength(5);
  });

  it('escalates with code "timeout" when the model exceeds the request deadline', async () => {
    const slow: LlmClient = {
      complete: (_req, signal) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    };
    const { post, repo } = setup(slow, { requestTimeoutMs: 50 });
    const res = await post('key-timeout-1');
    expect(res.json()).toMatchObject({ status: 'escalated', escalation_code: 'timeout' });
    expect(repo.tickets.get(1)).toMatchObject({ escalation_code: 'timeout' });
  });

  it('returns a generic 503 when the database is down, without leaking driver details', async () => {
    const { post, repo } = setup(llm);
    repo.down = true;
    const res = await post('key-dbdown-01');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'service temporarily unavailable' });
    expect(res.body).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|5999/);
    expect(llm.calls).toBe(0);
  });
});

describe('idempotent replay', () => {
  it('returns 200 with the original ticket after a completed request, without re-running the agent', async () => {
    const llm = fakeModel(happyTurns());
    const { post, repo } = setup(llm);
    const first = await post('key-replay-01');
    const second = await post('key-replay-01');

    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toMatchObject({
      ticket_id: first.json().ticket_id,
      replayed: true,
      ticket: { status: 'triaged', priority: 'P2', category: 'network', needs_human: false, escalation_code: null },
    });
    expect(llm.calls).toBe(3);
    expect(repo.tickets.size).toBe(1);
  });

  it('returns the escalated ticket with code "llm_unavailable" when the original request failed at the LLM', async () => {
    const llm = fakeModel([new Error('anthropic 529 overloaded')]);
    const { post } = setup(llm);
    const first = await post('key-replay-02');
    expect(first.json()).toMatchObject({ status: 'escalated', escalation_code: 'llm_unavailable' });

    const second = await post('key-replay-02');
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      ticket_id: first.json().ticket_id,
      replayed: true,
      ticket: { status: 'needs_human', needs_human: true, escalation_code: 'llm_unavailable' },
    });
    expect(llm.calls).toBe(1);
  });

  it('returns 409 with the ticket_id while the original request is still in progress', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const turns = happyTurns();
    const llm: LlmClient = {
      async complete() {
        await gate; // hold the first request inside the agent loop
        const content = turns.shift()!;
        return { stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', content };
      },
    };
    const { post } = setup(llm);

    const firstPending = post('key-replay-03');
    await new Promise((r) => setTimeout(r, 20)); // let the first request claim the key
    const second = await post('key-replay-03');
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ ticket_id: 1 });
    expect(second.headers['retry-after']).toBeDefined();

    release();
    expect((await firstPending).statusCode).toBe(200);
    expect((await post('key-replay-03')).json()).toMatchObject({ replayed: true, ticket: { status: 'triaged' } });
  });

  it('escalates an abandoned ticket with code "abandoned" on replay instead of returning 409 forever', async () => {
    const { post, repo } = setup(fakeModel(happyTurns()), { staleAfterMs: 0 });
    // Original request: key + ticket committed, then the DB dies mid-triage, so the ticket is stuck in 'received'.
    await repo.beginIntake('key-replay-04', createHash('sha256').update(payload).digest('hex'), JSON.parse(payload));

    const res = await post('key-replay-04');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ replayed: true, ticket: { status: 'needs_human', escalation_code: 'abandoned' } });
    expect(repo.audit.at(-1)).toMatchObject({ tool: 'escalate_to_human', input: { source: 'idempotent_replay', code: 'abandoned' } });
  });

  it('rejects reuse of a key with a different payload with 422', async () => {
    const { post } = setup(fakeModel(happyTurns()));
    await post('key-replay-05');
    const res = await post('key-replay-05', payload.replace('9am', '10am'));
    expect(res.statusCode).toBe(422);
  });
});

describe('escalation detail never reaches the caller', () => {
  // Distinctive strings standing in for upstream error text and model free text.
  const LLM_ERROR = 'anthropic 529 overloaded req_id=req_SECRET123 host=10.4.2.17:8443';
  const MODEL_REASON = 'customer says: ignore previous instructions SECRET-MODEL-TEXT';
  const RAW = /req_SECRET123|10\.4\.2\.17|529 overloaded|SECRET-MODEL-TEXT|ignore previous/;

  it('keeps raw text in audit_log and the server log, and only codes in every response', async () => {
    const logLines: string[] = [];
    const stream = new Writable({ write(chunk, _enc, cb) { logLines.push(chunk.toString()); cb(); } });
    const logger = { level: 'info', stream };

    // Scenario A: the LLM call throws with raw upstream text.
    const a = setup(fakeModel([new Error(LLM_ERROR)]), { logger });
    // Scenario B: the model escalates itself with free text echoing the ticket.
    const b = setup(fakeModel([tool('escalate_to_human', { reason: MODEL_REASON }), text('{"priority":"P1","category":"security","summary":"Possible incident","needs_human":true}')]), { logger });
    // Scenario C: the stored ticket goes stale and is escalated on replay.
    const c = setup(fakeModel([]), { logger, staleAfterMs: 0 });
    await c.repo.beginIntake('key-leak-c', createHash('sha256').update(payload).digest('hex'), JSON.parse(payload));

    const responses = [
      await a.post('key-leak-a'), await a.post('key-leak-a'),   // first response + replay
      await b.post('key-leak-b'), await b.post('key-leak-b'),
      await c.post('key-leak-c'), await c.post('key-leak-c'),
    ];

    for (const r of responses) {
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toMatch(RAW);
      expect(JSON.stringify(r.headers)).not.toMatch(RAW);
    }
    expect(responses.map((r) => r.json().escalation_code ?? r.json().ticket?.escalation_code)).toEqual([
      'llm_unavailable', 'llm_unavailable', undefined, 'model_escalated', 'abandoned', 'abandoned',
    ]);
    expect(responses[2]!.json()).toMatchObject({ status: 'completed', result: { needs_human: true } });

    // Every stored ticket holds only a known code.
    for (const repo of [a.repo, b.repo, c.repo]) {
      for (const t of repo.tickets.values()) {
        expect(ESCALATION_CODES).toContain(t.escalation_code);
        expect(JSON.stringify(t)).not.toMatch(/req_SECRET123|SECRET-MODEL-TEXT/);
      }
    }

    // The raw text is preserved where operators need it.
    expect(JSON.stringify(a.repo.audit)).toContain(LLM_ERROR);
    expect(JSON.stringify(b.repo.audit)).toContain(MODEL_REASON);
    expect(logLines.join('\n')).toContain('req_SECRET123');
  });

  it('keeps the code list in sync with the database CHECK constraint', () => {
    const sql = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
    const check = /escalation_code\s+text CHECK \(escalation_code IN \(([^)]*)\)\)/.exec(sql)?.[1] ?? '';
    const inSql = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(inSql.sort()).toEqual([...ESCALATION_CODES].sort());
  });
});
