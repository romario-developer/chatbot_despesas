import { Bot, InlineKeyboard } from 'grammy';
import { confirmationKeyboard, editKeyboard, expensesPaginationKeyboard } from './keyboards';
import { confirmDraft, deleteDraft, getDraftForUser } from '../services/draftService';
import { setSession, clearSession } from '../services/sessionService';
import { formatCurrency } from '../utils/money';
import { formatDate } from '../utils/dates';
import { buildExpensesListMessage } from './commands';
import { getMonthlyExpensesPage } from '../services/reportService';
import { getAdminUser } from '../services/userService';
import { cancelReset } from '../services/resetService';
import { ADMIN_TELEGRAM_ID } from '../utils/systemUsers';

function buildSummary(draft: {
  amountCents: number;
  description: string;
  category: { name: string };
  date: Date;
}) {
  return `Valor: ${formatCurrency(draft.amountCents)}\nCategoria: ${draft.category.name}\nDescri‡Æo: ${draft.description}\nData: ${formatDate(draft.date)}`;
}

export function registerCallbackHandlers(bot: Bot) {
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data || '';
    const telegramId = ctx.from?.id;
    if (!telegramId) {
      await ctx.answerCallbackQuery({ text: 'Usu rio nÆo identificado' });
      return;
    }
    const telegramIdStr = String(telegramId);
    const userKey = ADMIN_TELEGRAM_ID;

    try {
      if (data === 'reset:cancel') {
        const user = await getAdminUser();
        await cancelReset(user.id);
        await ctx.editMessageText('Operacao cancelada.');
        await ctx.answerCallbackQuery({ text: 'Cancelado' });
        return;
      }
      if (data.startsWith('exp:confirm:')) {
        const draftId = data.split(':')[2];
        const result = await confirmDraft(draftId, userKey);
        if (!result) {
          await ctx.answerCallbackQuery({ text: 'Rascunho nÆo encontrado' });
          return;
        }
        await clearSession(userKey);
        await ctx.editMessageText(
          `? Salvei!\n${buildSummary({
            amountCents: result.expense.amountCents,
            description: result.expense.description,
            category: { name: result.expense.category.name },
            date: result.expense.date,
          })}\nID #${result.expense.id}`,
        );
        await ctx.answerCallbackQuery({ text: 'Despesa registrada' });
        return;
      }

      if (data.startsWith('exp:cancel:')) {
        const draftId = data.split(':')[2];
        const result = await deleteDraft(draftId, userKey);
        await clearSession(userKey);
        if (!result) {
          await ctx.answerCallbackQuery({ text: 'Rascunho nÆo encontrado' });
          return;
        }
        await ctx.editMessageText('Rascunho cancelado ?');
        await ctx.answerCallbackQuery({ text: 'Cancelado' });
        return;
      }

      if (data.startsWith('exp:edit:')) {
        const draftId = data.split(':')[2];
        const { draft } = await getDraftForUser(draftId, userKey);
        if (!draft) {
          await ctx.answerCallbackQuery({ text: 'Rascunho nÆo encontrado' });
          return;
        }

        await ctx.editMessageText(`O que deseja ajustar?\n${buildSummary(draft)}`, {
          reply_markup: editKeyboard(draft.id),
        });
        await ctx.answerCallbackQuery();
        return;
      }

      if (data.startsWith('exp:editfield:')) {
        const [, , draftId, field] = data.split(':');
        const { draft } = await getDraftForUser(draftId, userKey);
        if (!draft) {
          await ctx.answerCallbackQuery({ text: 'Rascunho nÆo encontrado' });
          return;
        }

        let prompt = '';
        if (field === 'value') {
          await setSession(userKey, 'edit:value', draftId);
          prompt = 'Envie o novo valor (ex: 40,50)';
        } else if (field === 'category') {
          await setSession(userKey, 'edit:category', draftId);
          prompt = 'Envie o nome da categoria';
        } else if (field === 'description') {
          await setSession(userKey, 'edit:description', draftId);
          prompt = 'Envie a nova descri‡Æo';
        } else if (field === 'date') {
          await setSession(userKey, 'edit:date', draftId);
          prompt = 'Envie a nova data (hoje, ontem, 25/12, 25/12/2025)';
        } else {
          await ctx.answerCallbackQuery({ text: 'Campo inv lido' });
          return;
        }

        await ctx.answerCallbackQuery();
        await ctx.editMessageText(`${prompt}\n\nRascunho atual:\n${buildSummary(draft)}`, {
          reply_markup: new InlineKeyboard().text('Cancelar ?', `exp:cancel:${draftId}`),
        });
        return;
      }

      if (data.startsWith('exp:list:')) {
        const parts = data.split(':');
        const ym = parts[2] || '';
        const pageRequested = Number.parseInt(parts[3] || '1', 10) || 1;
        const [yearStr, monthStr] = ym.split('-');
        const year = Number.parseInt(yearStr, 10);
        const month = Number.parseInt(monthStr, 10);
        if (!year || !month) {
          await ctx.answerCallbackQuery({ text: 'Per¡odo inv lido' });
          return;
        }

        const pageSize = 10;
        const pageData = await getMonthlyExpensesPage(userKey, month, year, pageRequested, pageSize);
        const message = buildExpensesListMessage({
          year,
          month,
          page: pageData.page,
          totalPages: pageData.totalPages,
          totalCount: pageData.totalCount,
          totalCents: pageData.totalCents,
          items: pageData.items,
        });

        const keyboard = expensesPaginationKeyboard(year, month, pageData.page, pageData.totalPages);
        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
        await ctx.answerCallbackQuery();
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro ao processar a‡Æo.';
      await ctx.answerCallbackQuery({ text: message, show_alert: true });
    }
  });
}
