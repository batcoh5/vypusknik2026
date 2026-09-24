import crypto from 'node:crypto';
import { createApp } from './app.js';

const env = process.env;

let adminToken = env.ADMIN_TOKEN;
if (!adminToken) {
  adminToken = crypto.randomBytes(18).toString('base64url');
  console.warn(`ADMIN_TOKEN не задан. Временный ключ администратора: ${adminToken}`);
}

// Railway: данные должны лежать на подключённом Volume, иначе они стираются при каждом деплое.
const onRailway = Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID);
const volume = env.RAILWAY_VOLUME_MOUNT_PATH;
const dataDir = env.DATA_DIR ?? volume;
const ephemeral = onRailway && (!volume || !(dataDir ?? '').startsWith(volume));
if (ephemeral) {
  console.error(
    'ВНИМАНИЕ: данные не сохранятся после деплоя! Подключите к сервису Volume (Settings → Volumes) ' +
      'и уберите DATA_DIR или укажите в нём путь Volume.',
  );
}

const { server } = await createApp({
  dataDir,
  storageWarning: ephemeral,
  adminToken,
  maxVotesPerIp: Number(env.MAX_VOTES_PER_IP ?? 0),
  trustProxy: env.TRUST_PROXY === '1',
  secureCookies: env.SECURE_COOKIES === '1',
  smsApiId: env.SMS_RU_API_ID,
  smsTest: env.SMS_TEST === '1',
  smsDailyLimit: env.SMS_DAILY_LIMIT ? Number(env.SMS_DAILY_LIMIT) : undefined,
  devLogin: env.DEV_LOGIN === '1',
});

if (!env.SMS_RU_API_ID) {
  console.warn('SMS не настроены: задайте SMS_RU_API_ID (см. README).');
}
if (env.DEV_LOGIN === '1') {
  console.warn('Включён тестовый вход: код показывается на экране (DEV_LOGIN=1). Не используйте на настоящем голосовании!');
}

const port = Number(env.PORT ?? 3000);
server.listen(port, env.HOST ?? '0.0.0.0', () => {
  console.log(`Выпускник Краснообска 2026: сайт голосования запущен на http://localhost:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
