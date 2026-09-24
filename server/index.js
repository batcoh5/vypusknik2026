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
  adminToken,
  maxVotesPerIp: Number(env.MAX_VOTES_PER_IP ?? 0),
  trustProxy: env.TRUST_PROXY === '1',
  secureCookies: env.SECURE_COOKIES === '1',
  vkClientId: env.VK_CLIENT_ID,
  publicUrl: env.PUBLIC_URL,
  devLogin: env.DEV_LOGIN === '1',
});

if (!env.VK_CLIENT_ID || !env.PUBLIC_URL) {
  console.warn('Вход через ВКонтакте не настроен: задайте VK_CLIENT_ID и PUBLIC_URL (см. README).');
}
if (env.DEV_LOGIN === '1') {
  console.warn('Включён тестовый вход без ВКонтакте (DEV_LOGIN=1). Не используйте его на настоящем голосовании!');
}

const port = Number(env.PORT ?? 3000);
server.listen(port, env.HOST ?? '0.0.0.0', () => {
  console.log(`Выпускник Краснообска 2026: сайт голосования запущен на http://localhost:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
