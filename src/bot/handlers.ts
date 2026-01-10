import { Bot } from 'grammy';
import { parseExpenseText } from '../services/parseExpenseText';
import { formatCurrency } from '../utils/money';
import { formatDate, dayjs, TZ } from '../utils/dates';
import { createDraftFromParsed, getDraftForUser, updateDraft } from '../services/draftService';
import { findCardByNameGuess } from '../services/cardService';
import { confirmationKeyboard, editKeyboard } from './keyboards';
import { clearSession, getSessionByUserId } from '../services/sessionService';
import { getOrCreateCategory } from '../services/categoryService';
import { amountStringToCents } from '../utils/money';
import { parseDateFromText } from '../utils/dates';
import { confirmAndExecuteReset } from '../services/resetService';
import {
  handleDespesasCommand,
  handleRelatorioCommand,
  sendAjuda,
  sendRegistrarHint,
  sendCategorias,
  handleClearScreen,
} from './commands';
import { buildMenuKeyboard, MENU_LABELS } from './menu';
import { resolveLinkedUser } from './telegramUser';

function buildSummary(draft: {
  amountCents: number;
  description: string;
  category: { name: string };
  date: Date;
}) {
  return `Valor: ${formatCurrency(draft.amountCents)}\nCategoria: ${draft.category.name}\nDescri‡Æo: ${draft.description}\nData: ${formatDate(draft.date)}`;
}

function issuesLabel(issues: string[]) {
  if (!issues.length) return '';
  const labels = issues.map((i) => {
    if (i === 'missing_description') return 'Falta descri‡Æo';
    if (i === 'ambiguous_category') return 'Categoria pode estar incorreta';
    return i;
  });
  return `\n\n?? Ajustes sugeridos: ${labels.join(' | ')}`;
}

async function handleSessionInput(ctx: any, userId: number, mode: string, draftId: string) {
  const text = ctx.message.text ?? '';
  const { draft } = await getDraftForUser(draftId, userId);
  if (!draft) {
    await clearSession(userId);
    await ctx.reply('NÆo encontrei o rascunho. Reenvie o gasto.');
    return;
  }

  if (mode === 'edit:value') {
    const amountCents = amountStringToCents(text);
    if (amountCents === null) {
      await ctx.reply('Valor inv lido. Envie algo como 40 ou 40,50.');
      return;
    }
    await updateDraft(draftId, userId, { amountCents });
  } else if (mode === 'edit:category') {
    const category = await getOrCreateCategory(userId, text);
    await updateDraft(draftId, userId, { categoryId: category.id });
  } else if (mode === 'edit:description') {
    const description = text.trim() || 'Sem descri‡Æo';
    await updateDraft(draftId, userId, { description });
  } else if (mode === 'edit:date') {
    const parsed = parseDateFromText(text);
    if (!parsed) {
      await ctx.reply('Data inv lida. Use hoje, ontem, 25/12 ou 25/12/2025.');
      return;
    }
    const date = dayjs(parsed.date).tz(TZ).startOf('day').toDate();
    await updateDraft(draftId, userId, { date });
  }

  await clearSession(userId);
  const updated = await getDraftForUser(draftId, userId);
  if (!updated.draft) {
    await ctx.reply('NÆo encontrei o rascunho ap¢s editar.');
    return;
  }

  const summary = buildSummary(updated.draft);
  await ctx.reply(`Atualizei o rascunho:\n${summary}`, {
    reply_markup: confirmationKeyboard(updated.draft.id),
  });
}

async function handleMenuShortcut(ctx: any, text: string) {
  const label = text.trim();
  if (label === MENU_LABELS.report) {
    await handleRelatorioCommand(ctx);
    return true;
  }
  if (label === MENU_LABELS.expenses) {
    await handleDespesasCommand(ctx, { month: undefined, year: undefined });
    return true;
  }
  if (label === MENU_LABELS.help) {
    await sendAjuda(ctx);
    return true;
  }
  if (label === MENU_LABELS.categories) {
    await sendCategorias(ctx);
    return true;
  }
  if (label === MENU_LABELS.register) {
    await sendRegistrarHint(ctx);
    return true;
  }
  if (label === MENU_LABELS.clear) {
    await handleClearScreen(ctx);
    return true;
  }
  return false;
}

export function registerMessageHandlers(bot: Bot) {
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text ?? '';
    if (!text || text.startsWith('/')) {
      return;
    }

    const telegramId = ctx.from?.id;
    if (!telegramId) return;
    const telegramIdStr = String(telegramId);
    const linkedUser = await resolveLinkedUser(ctx);
    if (!linkedUser) {
      await ctx.reply('Seu Telegram nao esta vinculado. Abra o PWA e conecte.', {
        reply_markup: buildMenuKeyboard(),
      });
      return;
    }

    const sessionData = await getSessionByUserId(linkedUser.id);
    const { session } = sessionData;

    const resetMatch = text.trim().match(/^RESET\s+(.+)$/i);
    if (resetMatch) {
      const token = resetMatch[1]?.trim() || '';
      if (!token) {
        await ctx.reply('Token invalido. Envie /reset_total para gerar um novo codigo.');
        return;
      }

      const result = await confirmAndExecuteReset(linkedUser.id, token);
      if (!result.ok) {
        await ctx.reply('Token invalido ou expirado. Envie /reset_total para gerar um novo.', {
          reply_markup: buildMenuKeyboard(),
        });
      } else {
        console.info(`reset_total executed for telegramId=${telegramIdStr}`);
        await ctx.reply('? Reset concluido. Seu historico foi apagado.', {
          reply_markup: buildMenuKeyboard(),
        });
      }
      return;
    }

    if (session?.mode === 'confirm:delete' && session.draftId) {
      const expected = `APAGAR ${session.draftId.split('-')[1]}/${session.draftId.split('-')[0]}`;
      const normalized = text.trim().toUpperCase();
      if (normalized === expected) {
        const [yearStr, monthStr] = session.draftId.split('-');
        const year = Number.parseInt(yearStr, 10);
        const month = Number.parseInt(monthStr, 10);
        if (year && month) {
          const { deleteExpensesForMonth } = await import('../services/expenseService');
          const result = await deleteExpensesForMonth(linkedUser.id, month, year);
          await ctx.reply(
            `Apaguei ${result.deletedCount} despesas de ${monthStr}/${year}.`,
          );
        } else {
          await ctx.reply('Per¡odo inv lido para apagar despesas.');
        }
        await clearSession(linkedUser.id);
      } else {
        await ctx.reply('Confirma‡Æo incorreta. Digite exatamente: ' + expected);
      }
      return;
    } else if (session?.mode && session.draftId) {
      await handleSessionInput(ctx, linkedUser.id, session.mode, session.draftId);
      return;
    }

    const handled = await handleMenuShortcut(ctx, text);
    if (handled) return;

    try {
      const parsed = parseExpenseText(text);
      if (parsed.cardNameGuess && parsed.paymentMethod === 'CREDIT') {
        const matchedCard = await findCardByNameGuess(linkedUser.id, parsed.cardNameGuess);
        parsed.cardId = matchedCard?.id ?? null;
      }
      const { draft } = await createDraftFromParsed(linkedUser.id, parsed);

      const summary = buildSummary(draft);
      const baseMessage = `Entendi assim:\n${summary}${issuesLabel(parsed.issues)}\nConfirma?`;

      await ctx.reply(baseMessage, { reply_markup: confirmationKeyboard(draft.id) });

      if (parsed.confidence === 'low') {
        await ctx.reply('NÆo tenho certeza. O que vocˆ quer ajustar?', {
          reply_markup: editKeyboard(draft.id),
        });
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'NÆo consegui registrar. Reenvie com valor, descri‡Æo e opcional categoria.';
      await ctx.reply(message);
    }
  });
}
