-- Demo customers for local development only. Do not load into production.
INSERT INTO customers (email, name, plan) VALUES
  ('ops@acme.example',    'Acme Dental',     'premium'),
  ('it@globex.example',   'Globex Logistics', 'standard')
ON CONFLICT (email) DO NOTHING;
