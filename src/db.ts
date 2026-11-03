import pg from 'pg';

export type Priority = 'P1' | 'P2' | 'P3' | 'P4';
export type TicketStatus = 'received' | 'triaged' | 'needs_human';

/**
 * Public, stable reasons a ticket was handed to a human. These are the only escalation
 * values stored on tickets or returned to callers; raw error text goes to audit_log and logs.
 * Keep in sync with the CHECK constraint on tickets.escalation_code in db/schema.sql.
 */
export const ESCALATION_CODES = [
  'llm_unavailable', // the model API failed (overloaded, 5xx, network, auth)
  'timeout',         // the per-request deadline expired
  'schema_invalid',  // the final answer failed validation twice
  'tool_limit',      // the model exceeded MAX_TOOL_CALLS
  'model_flagged',   // valid final answer with needs_human: true
  'model_escalated', // the model called escalate_to_human itself
  'abandoned',       // the original request died before finishing; escalated on replay
  'agent_error',     // any other unexpected failure in the agent loop
] as const;
export type EscalationCode = (typeof ESCALATION_CODES)[number];

export interface Customer {
  id: number;
  email: string;
  name: string;
  plan: string;
}

export interface Intake {
  customer_email: string;
  subject: string;
  body: string;
}

export interface TriageFields {
  customer_id: number;
  priority: Priority;
  category: string;
  summary: string;
}

export interface TicketSnapshot {
  id: number;
  status: TicketStatus;
  priority: Priority | null;
  category: string | null;
  summary: string | null;
  needs_human: boolean;
  escalation_code: EscalationCode | null;
}

export interface AuditEntry {
  ticket_id: number;
  tool: string;
  input: unknown;
  output: unknown;
  latency_ms: number;
}

/** Result of claiming an idempotency key: either we created the ticket, or the key already points at one. */
export type IntakeClaim =
  | { kind: 'created'; ticketId: number }
  | { kind: 'replay'; ticketId: number; requestHash: string };

/**
 * Any storage failure. The message is deliberately generic so it is safe to surface;
 * the driver error (host, port, SQL) is kept on `cause` for logs only.
 */
export class RepoError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`database operation failed: ${operation}`, { cause });
    this.name = 'RepoError';
  }
}

/** Everything the app needs from storage. Tests swap in an in-memory implementation. */
export interface Repo {
  /** Atomically claims the key and creates the intake ticket, or returns the ticket the key already owns. */
  beginIntake(key: string, requestHash: string, intake: Intake): Promise<IntakeClaim>;
  getTicket(ticketId: number): Promise<TicketSnapshot | null>;
  /** Escalates (code 'abandoned') a ticket still in 'received' whose last update is older than staleAfterMs. True if it did. */
  escalateIfStale(ticketId: number, staleAfterMs: number): Promise<boolean>;
  findCustomerByEmail(email: string): Promise<Customer | null>;
  updateTicketTriage(ticketId: number, fields: TriageFields): Promise<void>;
  markNeedsHuman(ticketId: number, code: EscalationCode): Promise<void>;
  logAudit(entry: AuditEntry): Promise<void>;
  close(): Promise<void>;
}

const TICKET_COLUMNS = 'id, status, priority, category, summary, needs_human, escalation_code';

export class PgRepo implements Repo {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    // Fail fast when the database is unreachable instead of hanging until the client gives up.
    this.pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5_000 });
  }

  private async run<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw err instanceof RepoError ? err : new RepoError(operation, err);
    }
  }

  beginIntake(key: string, requestHash: string, i: Intake): Promise<IntakeClaim> {
    return this.run('beginIntake', async () => {
      const client = await this.pool.connect();
      let failed = false;
      try {
        await client.query('BEGIN');
        const t = await client.query<{ id: number }>(
          `INSERT INTO tickets (customer_email, subject, body) VALUES ($1, $2, $3) RETURNING id`,
          [i.customer_email, i.subject, i.body],
        );
        const ticketId = t.rows[0]!.id;
        // A concurrent insert of the same key blocks here until the other transaction commits or rolls back.
        const k = await client.query(
          `INSERT INTO idempotency_keys (idempotency_key, ticket_id, request_hash) VALUES ($1, $2, $3)
           ON CONFLICT (idempotency_key) DO NOTHING RETURNING ticket_id`,
          [key, ticketId, requestHash],
        );
        if (k.rowCount === 1) {
          await client.query('COMMIT');
          return { kind: 'created', ticketId };
        }
        await client.query('ROLLBACK'); // drop the speculative ticket row
        const existing = await client.query<{ ticket_id: number; request_hash: string }>(
          `SELECT ticket_id, request_hash FROM idempotency_keys WHERE idempotency_key = $1`,
          [key],
        );
        const row = existing.rows[0];
        if (!row) throw new Error('idempotency key conflict but no existing row');
        return { kind: 'replay', ticketId: row.ticket_id, requestHash: row.request_hash };
      } catch (err) {
        failed = true;
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release(failed); // destroy the connection if it may be broken
      }
    });
  }

  getTicket(ticketId: number): Promise<TicketSnapshot | null> {
    return this.run('getTicket', async () => {
      const r = await this.pool.query<TicketSnapshot>(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE id = $1`, [ticketId]);
      return r.rows[0] ?? null;
    });
  }

  escalateIfStale(ticketId: number, staleAfterMs: number): Promise<boolean> {
    return this.run('escalateIfStale', async () => {
      // Compared against the database clock, and atomic: only one concurrent retry can win.
      const r = await this.pool.query(
        `UPDATE tickets
            SET needs_human = true, status = 'needs_human', escalation_code = 'abandoned', updated_at = now()
          WHERE id = $1 AND status = 'received'
            AND updated_at < now() - ($2::integer * interval '1 millisecond')`,
        [ticketId, staleAfterMs],
      );
      return r.rowCount === 1;
    });
  }

  findCustomerByEmail(email: string): Promise<Customer | null> {
    return this.run('findCustomerByEmail', async () => {
      const r = await this.pool.query<Customer>(
        `SELECT id, email, name, plan FROM customers WHERE lower(email) = lower($1)`,
        [email],
      );
      return r.rows[0] ?? null;
    });
  }

  updateTicketTriage(ticketId: number, f: TriageFields): Promise<void> {
    return this.run('updateTicketTriage', async () => {
      await this.pool.query(
        `UPDATE tickets
            SET customer_id = $2, priority = $3, category = $4, summary = $5,
                status = CASE WHEN needs_human THEN 'needs_human' ELSE 'triaged' END,
                updated_at = now()
          WHERE id = $1`,
        [ticketId, f.customer_id, f.priority, f.category, f.summary],
      );
    });
  }

  markNeedsHuman(ticketId: number, code: EscalationCode): Promise<void> {
    return this.run('markNeedsHuman', async () => {
      await this.pool.query(
        `UPDATE tickets
            SET needs_human = true, status = 'needs_human', escalation_code = $2, updated_at = now()
          WHERE id = $1`,
        [ticketId, code],
      );
    });
  }

  logAudit(e: AuditEntry): Promise<void> {
    return this.run('logAudit', async () => {
      await this.pool.query(
        `INSERT INTO audit_log (ticket_id, tool, input, output, latency_ms)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)`,
        [e.ticket_id, e.tool, JSON.stringify(e.input ?? null), JSON.stringify(e.output ?? null), e.latency_ms],
      );
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
