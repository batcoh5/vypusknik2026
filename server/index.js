import crypto from 'node:crypto';
import { createApp } from './app.js';

const env = process.env;

let adminToken = env.ADMIN_TOKEN;
if (!adminToken) {
  adminToken = crypto.randomBytes(18).toString('base64url');
  console.warn(`ADMIN_TOKEN не задан. Временный ключ администратора: ${adminToken}`);
}

const { server } = await createApp({
  dataDir: env.DATA_DIR,
  configPath: env.ELECTION_CONFIG,
  adminToken,
  maxVotesPerIp: Number(env.MAX_VOTES_PER_IP ?? 0),
  trustProxy: env.TRUST_PROXY === '1',
  secureCookies: env.SECURE_COOKIES === '1',
});

const port = Number(env.PORT ?? 3000);
server.listen(port, env.HOST ?? '0.0.0.0', () => {
  console.log(`Выпускник 2026: сайт голосования запущен на http://localhost:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
