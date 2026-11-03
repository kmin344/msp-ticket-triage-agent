import { createHash } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import { runTriageAgent, type LlmClient } from './agent.js';
import { RepoError, type Repo } from './db.js';
import { verifySignature } from './signature.js';
import { makeTools } from './tools.js';

export interface ServerDeps {
  repo: Repo;
  llm: LlmClient;
  webhookSecret: string;
  requestTimeoutMs: number;
  maxToolCalls: number;
  /** A ticket still 'received' after this long is treated as abandoned on replay. Default: 2 × timeout + 10 s. */
  staleAfterMs?: number;
  /** true, false, or Fastify logger options (tests pass a capturing stream). */
  logger?: FastifyServerOptions['logger'];
}

const TicketWebhookSchema = z.object({
  customer_email: z.string().email(),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20_000),
});

const IdempotencyKeySchema = z.string().min(8).max(200);

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 64 * 1024 });
  const staleAfterMs = deps.staleAfterMs ?? deps.requestTimeoutMs * 2 + 10_000;

  // Keep the raw bytes: the HMAC must be computed over exactly what was sent.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // Log the real error; never send driver messages, hosts or ports to the caller.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof RepoError) {
      req.log.error({ err: err.cause ?? err, operation: err.message }, 'database error');
      return reply.code(503).header('retry-after', '5').send({ error: 'service temporarily unavailable' });
    }
    const status = err.statusCode ?? 500;
    if (status < 500) return reply.code(status).send({ error: err.message }); // Fastify client errors (413, 415, ...)
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal server error' });
  });

  app.get('/health', async () => ({ ok: true }));

  app.post('/webhooks/ticket', async (req, reply) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    // 1. Authenticate before anything else (including idempotency, so forged requests can't burn keys).
    if (!verifySignature(deps.webhookSecret, raw, header(req.headers['x-signature']))) {
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const key = IdempotencyKeySchema.safeParse(header(req.headers['x-idempotency-key']));
    if (!key.success) return reply.code(400).send({ error: 'missing or invalid x-idempotency-key' });

    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'body is not valid JSON' });
    }
    const payload = TicketWebhookSchema.safeParse(json);
    if (!payload.success) return reply.code(400).send({ error: 'invalid payload', issues: payload.error.issues });

    // 2. Claim the key and create the intake ticket in one transaction.
    const requestHash = createHash('sha256').update(raw).digest('hex');
    const claim = await deps.repo.beginIntake(key.data, requestHash, payload.data);
    if (claim.kind === 'replay') {
      if (claim.requestHash !== requestHash) {
        return reply.code(422).send({ error: 'idempotency key was already used with a different payload' });
      }
      return replay(claim.ticketId, reply);
    }

    // 3. Run the agent with a hard per-request deadline.
    const ticketId = claim.ticketId;
    const outcome = await runTriageAgent({
      llm: deps.llm,
      tools: makeTools(deps.repo, ticketId),
      ticket: payload.data,
      signal: AbortSignal.timeout(deps.requestTimeoutMs),
      maxToolCalls: deps.maxToolCalls,
    });

    // Built field by field: outcome.detail (raw upstream error text) must never reach the caller.
    if (outcome.status === 'escalated') {
      req.log.warn({ ticketId, code: outcome.code, detail: outcome.detail, toolCalls: outcome.toolCalls }, 'ticket escalated');
      return reply.code(200).send({
        ticket_id: ticketId, replayed: false, status: 'escalated', escalation_code: outcome.code, toolCalls: outcome.toolCalls,
      });
    }
    req.log.info({ ticketId, toolCalls: outcome.toolCalls }, 'triage completed');
    return reply.code(200).send({
      ticket_id: ticketId, replayed: false, status: 'completed', result: outcome.result, toolCalls: outcome.toolCalls,
    });
  });

  /** Same key, same payload: report what happened to the original request instead of re-running it. */
  async function replay(ticketId: number, reply: FastifyReply) {
    let ticket = await deps.repo.getTicket(ticketId);
    if (!ticket) throw new Error(`idempotency key points at missing ticket ${ticketId}`);

    if (ticket.status === 'received') {
      // Either the first request is still running, or it died before finishing (crash, DB outage).
      if (!(await deps.repo.escalateIfStale(ticketId, staleAfterMs))) {
        return reply
          .code(409)
          .header('retry-after', String(Math.ceil(staleAfterMs / 1000)))
          .send({ error: 'original request is still being processed', ticket_id: ticketId });
      }
      await deps.repo.logAudit({
        ticket_id: ticketId,
        tool: 'escalate_to_human',
        input: { source: 'idempotent_replay', code: 'abandoned', detail: `ticket still 'received' after ${staleAfterMs} ms` },
        output: { ok: true, data: { ticket_id: ticketId, needs_human: true, escalation_code: 'abandoned' } },
        latency_ms: 0,
      });
      ticket = (await deps.repo.getTicket(ticketId)) ?? ticket;
    }

    return reply.code(200).header('idempotent-replayed', 'true').send({ ticket_id: ticketId, replayed: true, ticket });
  }

  return app;
}

function header(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
