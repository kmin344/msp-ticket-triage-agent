import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { RepoError, type EscalationCode } from './db.js';
import { CATEGORIES, PRIORITIES, toolDefinitions, type ToolExecutor } from './tools.js';

export const TriageResultSchema = z.object({
  priority: z.enum(PRIORITIES),
  category: z.enum(CATEGORIES),
  summary: z.string().min(1),
  needs_human: z.boolean(),
});
export type TriageResult = z.infer<typeof TriageResultSchema>;

// ---- Injectable LLM client --------------------------------------------------

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

export interface LlmRequest {
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
}

export interface LlmClient {
  complete(req: LlmRequest, signal: AbortSignal): Promise<{ stop_reason: string | null; content: Block[] }>;
}

export function anthropicClient(apiKey: string, model: string): LlmClient {
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  return {
    async complete(req, signal) {
      const msg = await client.messages.create(
        { model, max_tokens: 1024, system: req.system, messages: req.messages, tools: req.tools },
        { signal },
      );
      const content = msg.content.flatMap((b): Block[] =>
        b.type === 'text' ? [{ type: 'text', text: b.text }]
        : b.type === 'tool_use' ? [{ type: 'tool_use', id: b.id, name: b.name, input: b.input }]
        : [],
      );
      return { stop_reason: msg.stop_reason, content };
    },
  };
}

// ---- Agent loop -------------------------------------------------------------

const SYSTEM_PROMPT = `You triage support tickets for a managed service provider (MSP).
Steps: 1) call lookup_customer with the sender's email. 2) If the customer is unknown, or the ticket
describes an active security incident, call escalate_to_human. 3) Otherwise call create_ticket.
Priorities: P1 = outage or security incident affecting the business; P2 = major degradation, many users;
P3 = single user blocked or degraded; P4 = question or low-impact request.
When done, reply with ONLY a JSON object, no prose:
{"priority":"P1|P2|P3|P4","category":"${CATEGORIES.join('|')}","summary":"...","needs_human":true|false}`;

export type AgentOutcome =
  | { status: 'completed'; result: TriageResult; toolCalls: number }
  | {
      status: 'escalated';
      code: EscalationCode;
      /** Internal only (raw upstream error text etc.): for logs, never for responses. */
      detail: string;
      toolCalls: number;
    };

export interface RunOptions {
  llm: LlmClient;
  tools: ToolExecutor;
  ticket: { customer_email: string; subject: string; body: string };
  signal: AbortSignal;
  maxToolCalls?: number;
  maxSchemaFailures?: number;
}

export async function runTriageAgent(opts: RunOptions): Promise<AgentOutcome> {
  const { llm, tools, ticket, signal, maxToolCalls = 5, maxSchemaFailures = 2 } = opts;
  let toolCalls = 0;
  let schemaFailures = 0;
  let modelEscalated = false;

  // System-initiated escalation is audited (with the raw detail), but not counted toward the cap.
  const escalate = async (code: EscalationCode, detail: string): Promise<AgentOutcome> => {
    await tools.escalate(code, detail);
    return { status: 'escalated', code, detail, toolCalls };
  };

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `From: ${ticket.customer_email}\nSubject: ${ticket.subject}\n\n<ticket_body>\n${ticket.body}\n</ticket_body>`,
    },
  ];

  try {
    for (;;) {
      signal.throwIfAborted();
      let res: Awaited<ReturnType<LlmClient['complete']>>;
      try {
        res = await llm.complete({ system: SYSTEM_PROMPT, messages, tools: toolDefinitions }, signal);
      } catch (err) {
        if (signal.aborted) throw err; // classified as timeout below
        return await escalate('llm_unavailable', errorText(err));
      }
      messages.push({ role: 'assistant', content: res.content.map(toParam) });

      const toolUses = res.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
      if (toolUses.length > 0) {
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const use of toolUses) {
          if (toolCalls >= maxToolCalls) return await escalate('tool_limit', `model requested more than ${maxToolCalls} tool calls`);
          toolCalls++;
          const out = await tools.execute(use.name, use.input);
          if (use.name === 'escalate_to_human' && out.ok) modelEscalated = true;
          results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(out), is_error: !out.ok });
        }
        messages.push({ role: 'user', content: results });
        continue;
      }

      const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      const parsed = parseFinalAnswer(text);
      if (parsed.success) {
        if (parsed.data.needs_human && !modelEscalated) {
          await tools.escalate('model_flagged', parsed.data.summary);
        }
        return { status: 'completed', result: parsed.data, toolCalls };
      }

      schemaFailures++;
      if (schemaFailures >= maxSchemaFailures) {
        return await escalate('schema_invalid', `${schemaFailures} invalid final answers; last: ${parsed.error}`);
      }
      messages.push({
        role: 'user',
        content: `Your final answer was invalid: ${parsed.error}. Reply with ONLY the JSON object.`,
      });
    }
  } catch (err) {
    if (err instanceof RepoError) throw err; // storage is down: escalating would fail too; the server answers 503
    if (signal.aborted) return await escalate('timeout', errorText(err));
    return await escalate('agent_error', errorText(err));
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function toParam(b: Block): Anthropic.ContentBlockParam {
  return b.type === 'text'
    ? { type: 'text', text: b.text }
    : { type: 'tool_use', id: b.id, name: b.name, input: b.input };
}

function parseFinalAnswer(text: string): { success: true; data: TriageResult } | { success: false; error: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return { success: false, error: 'no JSON object found' };
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { success: false, error: 'malformed JSON' };
  }
  const r = TriageResultSchema.safeParse(json);
  return r.success
    ? { success: true, data: r.data }
    : { success: false, error: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
}
