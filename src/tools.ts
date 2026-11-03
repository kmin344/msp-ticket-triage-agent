import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { EscalationCode, Repo } from './db.js';

export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export const CATEGORIES = ['network', 'hardware', 'software', 'security', 'account_access', 'email', 'billing', 'other'] as const;

const inputSchemas = {
  lookup_customer: z.object({ email: z.string().email() }),
  create_ticket: z.object({
    customer_id: z.number().int().positive(),
    priority: z.enum(PRIORITIES),
    category: z.enum(CATEGORIES),
    summary: z.string().min(1).max(500),
  }),
  escalate_to_human: z.object({ reason: z.string().min(1).max(500) }),
};

export type ToolName = keyof typeof inputSchemas;

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'lookup_customer',
    description: 'Look up an MSP customer by email. Returns the customer record or null if unknown.',
    input_schema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
  },
  {
    name: 'create_ticket',
    description: 'Record the triage result (customer, priority, category, summary) on the current ticket.',
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'integer' },
        priority: { type: 'string', enum: [...PRIORITIES] },
        category: { type: 'string', enum: [...CATEGORIES] },
        summary: { type: 'string', description: 'One or two sentences for the technician.' },
      },
      required: ['customer_id', 'priority', 'category', 'summary'],
    },
  },
  {
    name: 'escalate_to_human',
    description: 'Flag the current ticket for human review, e.g. unknown customer, security incident, or uncertainty.',
    input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
];

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

export interface ToolExecutor {
  /** Runs a tool the model asked for. */
  execute(name: string, input: unknown): Promise<ToolResult>;
  /**
   * System-initiated escalation. `code` is the public reason stored on the ticket;
   * `detail` (raw error text etc.) is written to audit_log only.
   */
  escalate(code: EscalationCode, detail: string): Promise<void>;
}

/** Tools are bound to one ticket, so the model can never touch another ticket. Every call is audited. */
export function makeTools(repo: Repo, ticketId: number): ToolExecutor {
  const handlers: Record<ToolName, (input: any) => Promise<unknown>> = {
    lookup_customer: ({ email }) => repo.findCustomerByEmail(email),
    create_ticket: async (f) => {
      await repo.updateTicketTriage(ticketId, f);
      return { ticket_id: ticketId, ...f };
    },
    // The model's free-text reason may echo untrusted ticket content: it is audited, never stored on the ticket.
    escalate_to_human: async () => {
      await repo.markNeedsHuman(ticketId, 'model_escalated');
      return { ticket_id: ticketId, needs_human: true, escalation_code: 'model_escalated' };
    },
  };

  const audit = (tool: string, input: unknown, output: ToolResult, started: number) =>
    repo.logAudit({ ticket_id: ticketId, tool, input, output, latency_ms: Math.round(performance.now() - started) });

  return {
    async execute(name, input) {
      const started = performance.now();
      let output: ToolResult;
      if (!(name in inputSchemas)) {
        output = { ok: false, error: `unknown tool: ${name}` };
      } else {
        const parsed = inputSchemas[name as ToolName].safeParse(input);
        if (!parsed.success) {
          output = { ok: false, error: `invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
        } else {
          try {
            output = { ok: true, data: await handlers[name as ToolName](parsed.data) };
          } catch (err) {
            output = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
      }
      await audit(name, input, output, started);
      return output;
    },

    async escalate(code, detail) {
      const started = performance.now();
      await repo.markNeedsHuman(ticketId, code);
      await audit(
        'escalate_to_human',
        { source: 'system', code, detail },
        { ok: true, data: { ticket_id: ticketId, needs_human: true, escalation_code: code } },
        started,
      );
    },
  };
}
