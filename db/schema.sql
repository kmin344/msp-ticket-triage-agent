CREATE TABLE IF NOT EXISTS customers (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  name       text NOT NULL,
  plan       text NOT NULL DEFAULT 'standard',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per inbound webhook. The intake row exists before the agent runs,
-- so every audit_log row has a ticket_id; create_ticket fills in the triage fields.
CREATE TABLE IF NOT EXISTS tickets (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_email    text NOT NULL,
  subject           text NOT NULL,
  body              text NOT NULL,
  customer_id       integer REFERENCES customers(id),
  priority          text CHECK (priority IN ('P1','P2','P3','P4')),
  category          text,
  summary           text,
  status            text NOT NULL DEFAULT 'received'
                    CHECK (status IN ('received','triaged','needs_human')),
  needs_human       boolean NOT NULL DEFAULT false,
  -- Stable public reason code (keep in sync with ESCALATION_CODES in src/db.ts).
  -- Raw error text and free-text reasons are stored only in audit_log.
  escalation_code   text CHECK (escalation_code IN (
                      'llm_unavailable','timeout','schema_invalid','tool_limit',
                      'model_flagged','model_escalated','abandoned','agent_error')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Inserted in the same transaction as the intake ticket, so a key never exists without its ticket.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key text PRIMARY KEY,          -- unique constraint = replay protection
  ticket_id       integer NOT NULL REFERENCES tickets(id),
  request_hash    text NOT NULL,             -- sha256 of the raw body; detects key reuse with a different payload
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id  integer NOT NULL REFERENCES tickets(id),
  tool       text NOT NULL,
  input      jsonb NOT NULL,
  output     jsonb NOT NULL,
  latency_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_ticket_id_idx ON audit_log (ticket_id);

INSERT INTO customers (email, name, plan) VALUES
  ('ops@acme.example',    'Acme Dental',     'premium'),
  ('it@globex.example',   'Globex Logistics', 'standard')
ON CONFLICT (email) DO NOTHING;
