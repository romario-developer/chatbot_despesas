import dotenv from 'dotenv';
import express from 'express';
import { webhookCallback } from 'grammy';
import './utils/dates';
import { createBot } from './bot/bot';

dotenv.config();
process.env.TZ = 'America/Bahia';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('Defina BOT_TOKEN no .env');
}

const PORT = Number(process.env.PORT) || 3000;
const USE_WEBHOOK = (process.env.USE_WEBHOOK || 'false').toLowerCase() === 'true';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

const bot = createBot(BOT_TOKEN);
const app = express();

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

if (USE_WEBHOOK && WEBHOOK_URL) {
  const path = '/webhook';
  app.use(path, webhookCallback(bot, 'express'));

  bot.api
    .setWebhook(`${WEBHOOK_URL}${path}`)
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Webhook ativo em ${WEBHOOK_URL}${path}`);
      });
    })
    .catch((err) => {
      console.error('Falha ao registrar webhook, usando polling.', err);
      bot.start();
      app.listen(PORT, () => console.log(`HTTP server ouvindo em ${PORT}`));
    });
} else {
  bot.start();
  app.listen(PORT, () => {
    console.log(`HTTP server ouvindo em ${PORT} | Bot em polling`);
  });
}
