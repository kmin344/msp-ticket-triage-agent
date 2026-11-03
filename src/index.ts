import { anthropicClient } from './agent.js';
import { loadConfig } from './config.js';
import { PgRepo } from './db.js';
import { buildServer } from './server.js';

const config = loadConfig();
const repo = new PgRepo(config.DATABASE_URL);
const app = buildServer({
  repo,
  llm: anthropicClient(config.ANTHROPIC_API_KEY, config.ANTHROPIC_MODEL),
  webhookSecret: config.WEBHOOK_SECRET,
  requestTimeoutMs: config.REQUEST_TIMEOUT_MS,
  maxToolCalls: config.MAX_TOOL_CALLS,
  logger: true,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await repo.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.PORT, host: config.HOST });
