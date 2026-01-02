import { Bot, InlineKeyboard } from 'grammy';
import { confirmationKeyboard, editKeyboard, expensesPaginationKeyboard } from './keyboards';
import { confirmDraft, deleteDraft, getDraftForUser } from '../services/draftService';
import { setSession, clearSession } from '../services/sessionService';
import { formatCurrency } from '../utils/money';
import { formatDate } from '../utils/dates';
import { buildExpensesListMessage } from './commands';
import { getMonthlyExpensesPage } from '../services/reportService';
import { getOrCreateUser } from '../services/userService';
import { cancelReset } from '../services/resetService';

function buildSummary(draft: {
  amountCents: number;
  description: string;
  category: { name: string };
  date: Date;
}) {
  return `Valor: ${formatCurrency(draft.amountCents)}\nCategoria: ${draft.category.name}\nDescrição: ${draft.description}\nData: ${formatDate(draft.date)}`;
}

export function registerCallbackHandlers(bot: Bot) {
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data || '';
    const telegramId = ctx.from?.id;
    if (!telegramId) {
      await ctx.answerCallbackQuery({ text: 'Usuário não identificado' });
      return;
    }
    const telegramIdStr = String(telegramId);

    try {
      if (data === 'reset:cancel') {
        const user = await getOrCreateUser(telegramIdStr);
        await cancelReset(user.id);
        await ctx.editMessageText('Operacao cancelada.');
        await ctx.answerCallbackQuery({ text: 'Cancelado' });
        return;
      }
      if (data.startsWith('exp:confirm:')) {
        const draftId = data.split(':')[2];
        const result = await confirmDraft(draftId, telegramIdStr);
        if (!result) {
          await ctx.answerCallbackQuery({ text: 'Rascunho não encontrado' });
          return;
        }
        await clearSession(telegramIdStr);
        await ctx.editMessageText(
          `✅ Salvei!\n${buildSummary({
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
        const result = await deleteDraft(draftId, telegramIdStr);
        await clearSession(telegramIdStr);
        if (!result) {
          await ctx.answerCallbackQuery({ text: 'Rascunho não encontrado' });
          return;
        }
        await ctx.editMessageText('Rascunho cancelado ❌');
        await ctx.answerCallbackQuery({ text: 'Cancelado' });
        return;
      }

      if (data.startsWith('exp:edit:')) {
        const draftId = data.split(':')[2];
        const { draft } = await getDraftForUser(draftId, telegramIdStr);
        if (!draft) {
          await ctx.answerCallbackQuery({ text: 'Rascunho não encontrado' });
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
        const { draft } = await getDraftForUser(draftId, telegramIdStr);
        if (!draft) {
          await ctx.answerCallbackQuery({ text: 'Rascunho não encontrado' });
          return;
        }

        let prompt = '';
        if (field === 'value') {
          await setSession(telegramIdStr, 'edit:value', draftId);
          prompt = 'Envie o novo valor (ex: 40,50)';
        } else if (field === 'category') {
          await setSession(telegramIdStr, 'edit:category', draftId);
          prompt = 'Envie o nome da categoria';
        } else if (field === 'description') {
          await setSession(telegramIdStr, 'edit:description', draftId);
          prompt = 'Envie a nova descrição';
        } else if (field === 'date') {
          await setSession(telegramIdStr, 'edit:date', draftId);
          prompt = 'Envie a nova data (hoje, ontem, 25/12, 25/12/2025)';
        } else {
          await ctx.answerCallbackQuery({ text: 'Campo inválido' });
          return;
        }

        await ctx.answerCallbackQuery();
        await ctx.editMessageText(`${prompt}\n\nRascunho atual:\n${buildSummary(draft)}`, {
          reply_markup: new InlineKeyboard().text('Cancelar ❌', `exp:cancel:${draftId}`),
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
          await ctx.answerCallbackQuery({ text: 'Período inválido' });
          return;
        }

        const pageSize = 10;
        const pageData = await getMonthlyExpensesPage(telegramIdStr, month, year, pageRequested, pageSize);
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
      const message = err instanceof Error ? err.message : 'Erro ao processar ação.';
      await ctx.answerCallbackQuery({ text: message, show_alert: true });
    }
  });
}
