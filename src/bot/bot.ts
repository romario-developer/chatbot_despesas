import { Bot } from 'grammy';
import { registerCommandHandlers } from './commands';
import { registerMessageHandlers } from './handlers';
import { registerCallbackHandlers } from './callbacks';

export function createBot(token: string) {
  const bot = new Bot(token);

  bot.use(async (ctx, next) => {
    const update = ctx.update;
    const chatId = update?.message?.chat?.id;
    if (typeof chatId !== 'undefined') {
      const telegramUserId = update?.message?.from?.id;
      const username = update?.message?.from?.username;
      console.log(
        `[telegram] chatId=${chatId} userId=${telegramUserId ?? 'n/a'} username=${username ?? 'n/a'}`,
      );
    }
    return next();
  });

  bot.api
    .setMyCommands([
      { command: 'start', description: 'Como usar' },
      { command: 'ajuda', description: 'Ajuda e exemplos' },
      { command: 'relatorio', description: 'Relatório mensal' },
      { command: 'categorias', description: 'Listar categorias' },
      { command: 'editar', description: 'Editar despesa por ID' },
      { command: 'remover', description: 'Remover despesa por ID' },
    ])
    .catch(() => {
      // ignore failures in command registration
    });

  registerCommandHandlers(bot);
  registerMessageHandlers(bot);
  registerCallbackHandlers(bot);

  return bot;
}
