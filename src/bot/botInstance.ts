import { createBot } from './bot';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('Defina BOT_TOKEN nas variaveis de ambiente');
}

export const bot = createBot(BOT_TOKEN);
