import { randomUUID } from 'crypto';
import { Bot, InlineKeyboard } from 'grammy';
import { amountStringToCents, formatCurrency, formatCurrencyNumber } from '../utils/money';
import { formatDate, nowBahia, parseDateFromText, dayjs, TZ } from '../utils/dates';
import {
  deleteExpense,
  deleteExpensesForMonth,
  updateExpenseAmount,
  updateExpenseCategory,
  updateExpenseDate,
  updateExpenseDescription,
} from '../services/expenseService';
import { getMonthlyExpensesPage } from '../services/reportService';
import { getAdminUser } from '../services/userService';
import { ensureDefaultCategory, listCategories } from '../services/categoryService';
import { getPlanningByUserId, upsertPlanning } from '../services/planningService';
import { consumeLinkCode, findUserIdByChatId } from '../services/telegramLinkService';
import { getMonthlySummary } from '../services/monthlySummaryService';
import { expensesPaginationKeyboard } from './keyboards';
import { buildMenuKeyboard, MENU_LABELS, removeMenuKeyboard } from './menu';
import { setSession, clearSession } from '../services/sessionService';
import { generateResetToken } from '../services/resetService';
import { prisma } from '../db/prisma';
import { ADMIN_TELEGRAM_ID } from '../utils/systemUsers';
import { parseExpenseText } from '../services/parseExpenseText';
import { createDraftFromParsed, confirmDraft } from '../services/draftService';

const BOT_USER_KEY = ADMIN_TELEGRAM_ID;

function parseMonthArg(raw?: string) {
  if (!raw) return null;
  const value = raw.trim();
  if (!/^\d{4}-\d{2}$/.test(value)) return null;
  const [yearStr, monthStr] = value.split('-');
  const year = Number.parseInt(yearStr, 10);
  const month = Number.parseInt(monthStr, 10);
  if (!year || month < 1 || month > 12) return null;
  return { year, month, key: `${yearStr}-${monthStr}` };
}

function parseAmountNumber(raw?: string) {
  if (!raw) return null;
  const cleaned = raw.toLowerCase().replace(/r\$\s*/g, '').replace(/\s+/g, '').trim();
  if (!cleaned) return null;
  let normalized = cleaned;
  const hasComma = normalized.includes(',');
  const hasDot = normalized.includes('.');
  if (hasComma && hasDot) {
    normalized = normalized.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    normalized = normalized.replace(',', '.');
  }
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) return null;
  return Number(parsed.toFixed(2));
}

function generateId() {
  if (typeof randomUUID === 'function') return randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatBRL(amount: number) {
  return formatCurrencyNumber(amount);
}

function requireTelegramId(ctx: any) {
  const telegramId = ctx.from?.id;
  if (!telegramId) {
    throw new Error('NÆo consegui identificar o usu rio do Telegram.');
  }
  return String(telegramId);
}

async function requireLinkedAdminUser(ctx: any) {
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (!chatId) {
    await ctx.reply('Nao consegui identificar o chat deste Telegram.', {
      reply_markup: buildMenuKeyboard(),
    });
    return null;
  }

  const isLinked = await findUserIdByChatId(String(chatId));
  if (!isLinked) {
    await ctx.reply(
      'Voce precisa vincular sua conta. No app, toque em "Conectar Telegram" e envie aqui: /link SEU_CODIGO',
      { reply_markup: buildMenuKeyboard() },
    );
    return null;
  }

  const adminUser = await getAdminUser();
  return adminUser.id;
}

function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(text: string, max = 35) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}.`;
}

function formatDateShort(date: Date) {
  return dayjs(date).format('DD/MM');
}

function resetCancelKeyboard() {
  return new InlineKeyboard().text('Cancelar', 'reset:cancel');
}

function buildCategoryBlock(
  categorySummary: { name: string; totalCents: number; count: number }[],
  totalCents: number,
) {
  if (!categorySummary.length || !totalCents) {
    return '<b>Categorias</b>\n\nSem lan‡amentos no per¡odo.';
  }

  const limit = 12;
  let categories = [...categorySummary];

  if (categories.length > limit) {
    const kept = categories.slice(0, limit);
    const rest = categories.slice(limit);
    const restTotal = rest.reduce((sum, c) => sum + c.totalCents, 0);
    if (restTotal > 0) {
      const existingOutrosIndex = kept.findIndex((c) => c.name.toLowerCase() === 'outros');
      if (existingOutrosIndex >= 0) {
        kept[existingOutrosIndex] = {
          ...kept[existingOutrosIndex],
          totalCents: kept[existingOutrosIndex].totalCents + restTotal,
        };
      } else {
        kept.push({ name: 'Outros', totalCents: restTotal, count: 0 });
      }
      categories = kept.sort((a, b) => b.totalCents - a.totalCents);
    } else {
      categories = kept;
    }
  }

  const lines = categories.map((c) => {
    const percent = totalCents ? Math.round((c.totalCents / totalCents) * 100) : 0;
    return `${escapeHtml(c.name)} - ${formatCurrency(c.totalCents)} (${percent}%)`;
  });

  return `<b>Categorias</b>\n\n${lines.join('\n\n')}`;
}

type ExpenseListItem = {
  id: number;
  date: Date;
  description: string;
  amountCents: number;
  category: { name: string };
};

export function buildExpensesListMessage(input: {
  year: number;
  month: number;
  page: number;
  totalPages: number;
  totalCount: number;
  totalCents: number;
  items: ExpenseListItem[];
}) {
  const monthStr = String(input.month).padStart(2, '0');
  const header = `<b>Despesas - ${monthStr}/${input.year}</b>`;
  const meta = `P gina ${input.page} de ${input.totalPages} - Itens ${input.totalCount}`;
  const totalLine = `<b>Total do mˆs: ${formatCurrency(input.totalCents)}</b>`;

  if (!input.totalCount) {
    return `${header}\n${meta}\n${totalLine}\n\nSem lan‡amentos neste mˆs.`;
  }

  const lines = input.items
    .map((e) => {
      const desc = truncate((e.description || '').trim() || 'Sem descri‡Æo');
      const line1 = `${e.id} - ${escapeHtml(desc)}`;
      const line2 = `${formatDateShort(e.date)} - ${escapeHtml(e.category.name)} - ${formatCurrency(
        e.amountCents,
      )}`;
      return `${line1}\n${line2}`;
    })
    .join('\n\n');

  return `${header}\n${meta}\n${totalLine}\n\n${lines}`;
}

export async function sendAjuda(ctx: any) {
  await ctx.reply(
    'Use o bot para registrar despesas por texto.\nExemplos: "paguei 35 no diesel", "luz 180 categoria contas".\n\nComandos:\n/start\n/menu\n/relatorio mes\n/relatorio MM/AAAA\n/despesas mes\n/despesas MM/AAAA\n/categorias\n/editar ID campo novo_valor\n/remover ID',
    { reply_markup: buildMenuKeyboard() },
  );
}

export async function sendRegistrarHint(ctx: any) {
  await ctx.reply(
    'Envie o gasto em texto, o bot cria um rascunho e pede confirma‡Æo.\nExemplos: "35 diesel", "mercado 128,90", "pix 60 pro JoÆo categoria servi‡os".',
    { reply_markup: buildMenuKeyboard() },
  );
}

export async function sendCategorias(ctx: any) {
  requireTelegramId(ctx);
  const user = await getAdminUser();
  await ensureDefaultCategory(user.id);
  const categories = await listCategories(user.id);
  if (!categories.length) {
    await ctx.reply('Nenhuma categoria cadastrada ainda.', { reply_markup: buildMenuKeyboard() });
    return;
  }

  const names = categories.map((c: { name: string }) => `- ${c.name}`).join('\n');
  await ctx.reply(`Categorias:\n${names}`, { reply_markup: buildMenuKeyboard() });
}

export async function handleRelatorioCommand(ctx: any) {
  try {
    const adminUserId = await requireLinkedAdminUser(ctx);
    if (!adminUserId) return;

    const monthArg = (ctx.match as string | undefined)?.trim() ?? '';
    let month = parseMonthArg(monthArg);

    if (!month) {
      const now = nowBahia();
      month = {
        year: now.year(),
        month: now.month() + 1,
        key: `${now.year()}-${String(now.month() + 1).padStart(2, '0')}`,
      };
    }

    const summary = await getMonthlySummary({ userId: BOT_USER_KEY, month: month.key });

    if (process.env.NODE_ENV !== 'production') {
      console.log('[telegram][relatorio] summary:', {
        adminUserId,
        month: month.key,
        expensesCount: summary.expensesCount,
        totalCents: summary.totalCents,
        total: summary.total,
      });
    }

    const periodLine = `Periodo: ${formatDate(summary.start)} a ${formatDate(summary.end)}`;
    const header = `<b>Relatorio - ${String(month.month).padStart(2, '0')}/${month.year}</b>`;
    const countLine = `Lancamentos: ${summary.expensesCount}`;
    const totalLine = `<b>Total: ${formatCurrency(summary.totalCents)}</b>`;

    const categoryBlock = buildCategoryBlock(
      summary.totalPorCategoria.map((c) => ({
        name: c.category,
        totalCents: c.totalCents,
        count: 0,
      })),
      summary.totalCents,
    );

    const parts = [header, periodLine, countLine, totalLine, '', categoryBlock];

    const message = parts.join('\n');

    await ctx.reply(message, { parse_mode: 'HTML', reply_markup: buildMenuKeyboard() });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro ao gerar relatorio.';
    await ctx.reply(message);
  }
}

export async function handleDespesasCommand(ctx: any, opts?: { month?: number; year?: number }) {
  try {
    requireTelegramId(ctx);
    const args = (ctx.match as string | undefined)?.trim().toLowerCase() ?? '';
    const now = nowBahia();
    let month = opts?.month ?? now.month() + 1;
    let year = opts?.year ?? now.year();

    if (!opts && args && args !== 'mes') {
      const match = args.match(/(\d{1,2})\/(\d{4})/);
      if (!match) {
        await ctx.reply('Use "mes" ou "MM/AAAA". Ex: /despesas 12/2025');
        return;
      }
      month = Number.parseInt(match[1], 10);
      year = Number.parseInt(match[2], 10);
    }

    const pageSize = 10;
    const pageData = await getMonthlyExpensesPage(BOT_USER_KEY, month, year, 1, pageSize);
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
    await ctx.reply(message, {
      parse_mode: 'HTML',
      reply_markup: keyboard ?? buildMenuKeyboard(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro ao listar despesas.';
    await ctx.reply(message);
  }
}

async function handleResetTotalCommand(ctx: any) {
  requireTelegramId(ctx);
  const user = await getAdminUser();
  const { token } = await generateResetToken(user.id);

  const lines = [
    '?? Isso apagara TODAS as suas despesas, rascunhos e categorias.',
    'Para confirmar, envie exatamente:',
    `RESET ${token}`,
    '',
    'O codigo expira em 5 minutos. Toque em Cancelar se mudou de ideia.',
  ];

  await ctx.reply(lines.join('\n'), {
    reply_markup: resetCancelKeyboard(),
  });
}

export async function handleClearScreen(ctx: any) {
  const chatId = ctx.chat?.id;
  const baseMessageId =
    ctx.message?.message_id ??
    (ctx.update.callback_query && 'message' in ctx.update.callback_query
      ? ctx.update.callback_query.message?.message_id
      : undefined);

  if (chatId && baseMessageId) {
    for (let i = 1; i <= 25; i += 1) {
      const targetId = baseMessageId - i;
      if (targetId <= 0) break;
      try {
        await ctx.api.deleteMessage(chatId, targetId);
      } catch {
        // ignore failures (likely messages not from bot)
      }
    }
  }

  await ctx.reply('Tela limpa. Seus registros continuam salvos.', { reply_markup: buildMenuKeyboard() });
}

async function handleSalarioCommand(ctx: any) {
  const userId = await requireLinkedAdminUser(ctx);
  if (!userId) return;
  const args = (ctx.match as string | undefined)?.trim().split(/\s+/).filter(Boolean) ?? [];
  const monthArg = args[0];
  const amountArg = args[1];

  const month = parseMonthArg(monthArg);
  const amount = parseAmountNumber(amountArg);

  if (!month || amount === null || amount <= 0) {
    await ctx.reply('Use: /salario YYYY-MM valor. Ex: /salario 2026-01 3500', {
      reply_markup: buildMenuKeyboard(),
    });
    return;
  }

  const planning = await getPlanningByUserId(userId);
  const salaryByMonth = { ...planning.salaryByMonth, [month.key]: amount };
  const updated = { ...planning, salaryByMonth };

  await upsertPlanning(userId, updated);

  await ctx.reply(`Sal rio de ${month.key} definido para ${formatBRL(amount)}`, {
    reply_markup: buildMenuKeyboard(),
  });
}

async function handleExtraCommand(ctx: any) {
  const userId = await requireLinkedAdminUser(ctx);
  if (!userId) return;
  const args = (ctx.match as string | undefined)?.trim().split(/\s+/).filter(Boolean) ?? [];
  const monthArg = args[0];
  const amountArg = args[1];
  const label = args.slice(2).join(' ').trim();

  const month = parseMonthArg(monthArg);
  const amount = parseAmountNumber(amountArg);

  if (!month || amount === null || amount <= 0) {
    await ctx.reply('Use: /extra YYYY-MM valor descriÎ’o(opcional). Ex: /extra 2026-01 250 freela', {
      reply_markup: buildMenuKeyboard(),
    });
    return;
  }

  const planning = await getPlanningByUserId(userId);
  const monthExtras = [...(planning.extrasByMonth[month.key] ?? [])];
  monthExtras.push({ id: generateId(), label: label || undefined, amount });
  const extrasByMonth = { ...planning.extrasByMonth, [month.key]: monthExtras };
  const updated = { ...planning, extrasByMonth };

  await upsertPlanning(userId, updated);

  const totalExtras = monthExtras.reduce((sum, item) => sum + item.amount, 0);
  await ctx.reply(
    `Extra adicionado. Total de extras em ${month.key}: ${formatBRL(totalExtras)}`,
    { reply_markup: buildMenuKeyboard() },
  );
}

async function handleFixaCommand(ctx: any) {
  const userId = await requireLinkedAdminUser(ctx);
  if (!userId) return;
  const args = (ctx.match as string | undefined)?.trim().split(/\s+/).filter(Boolean) ?? [];
  const amountArg = args[0];
  const label = args.slice(1).join(' ').trim();

  const amount = parseAmountNumber(amountArg);
  if (amount === null || amount <= 0) {
    await ctx.reply('Use: /fixa valor descriÎ’o(opcional). Ex: /fixa 120 internet', {
      reply_markup: buildMenuKeyboard(),
    });
    return;
  }

  const planning = await getPlanningByUserId(userId);
  const fixedBills = [...planning.fixedBills, { id: generateId(), label: label || undefined, amount }];
  const updated = { ...planning, fixedBills };

  await upsertPlanning(userId, updated);

  const totalFixas = fixedBills.reduce((sum, item) => sum + item.amount, 0);
  await ctx.reply(`Conta fixa adicionada. Total de fixas: ${formatBRL(totalFixas)}`, {
    reply_markup: buildMenuKeyboard(),
  });
}

async function handlePlanejamentoCommand(ctx: any) {
  const userId = await requireLinkedAdminUser(ctx);
  if (!userId) return;
  const args = (ctx.match as string | undefined)?.trim().split(/\s+/).filter(Boolean) ?? [];
  const maybeMonth = args[0];

  let month = maybeMonth ? parseMonthArg(maybeMonth) : null;

  if (!month) {
    const now = nowBahia();
    month = {
      year: now.year(),
      month: now.month() + 1,
      key: `${now.year()}-${String(now.month() + 1).padStart(2, '0')}`,
    };
  }

  const summary = await getMonthlySummary({ userId: BOT_USER_KEY, month: month.key });

  const receita = summary.salaryTotal + summary.extrasTotal;
  const fixas = summary.fixedPlannedTotal;
  const gastos = summary.total;
  const saldo = summary.balance;
  const saldoPrevisto = summary.forecastBalance;

  const message = [
    `?? Planejamento ${month.key}`,
    `Receita: ${formatBRL(receita)}`,
    `- Salario: ${formatBRL(summary.salaryTotal)}`,
    `- Extras: ${formatBRL(summary.extrasTotal)}`,
    `Fixas: ${formatBRL(fixas)}`,
    `Gastos do mes: ${formatBRL(gastos)}`,
    `Saldo: ${formatBRL(saldo)}`,
    `Saldo previsto: ${formatBRL(saldoPrevisto)}`,
  ].join('\n');

  if (process.env.NODE_ENV !== 'production') {
    console.log('[telegram][planejamento] summary:', {
      userId,
      month: month.key,
      salary: summary.salaryTotal,
      extras: summary.extrasTotal,
      fixas,
      expensesCount: summary.expensesCount,
      totalCents: summary.totalCents,
      total: summary.total,
      gastos,
      saldo,
      saldoPrevisto,
    });
    console.log('[telegram][planejamento] message preview:', message);
  }

  await ctx.reply(message, { reply_markup: buildMenuKeyboard() });
}

async function handleLinkCommand(ctx: any) {
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  const code = (ctx.match as string | undefined)?.trim();
  if (!chatId) {
    await ctx.reply('Nao consegui identificar o chat deste Telegram.', { reply_markup: buildMenuKeyboard() });
    return;
  }
  if (!code) {
    await ctx.reply(
      'No app, toque em "Conectar Telegram" e envie aqui: /link SEU_CODIGO',
      { reply_markup: buildMenuKeyboard() },
    );
    return;
  }

  const result = await consumeLinkCode(String(chatId), code);
  if (!result.ok) {
    if (result.reason === 'chat_already_linked') {
      await ctx.reply(
        'Este chat ja esta vinculado a outra conta. Desvincule no app antes de tentar novamente.',
        { reply_markup: buildMenuKeyboard() },
      );
      return;
    }
    await ctx.reply('Codigo invalido ou expirado. Gere outro codigo no app e tente novamente.', {
      reply_markup: buildMenuKeyboard(),
    });
    return;
  }

  await ctx.reply('Conta vinculada com sucesso. Agora seu planejamento sera sincronizado.', {
    reply_markup: buildMenuKeyboard(),
  });
}

async function handleMeCommand(ctx: any) {
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (!chatId) {
    await ctx.reply('N’o consegui identificar o chat deste Telegram.', { reply_markup: buildMenuKeyboard() });
    return;
  }
  const userId = await findUserIdByChatId(String(chatId));
  if (!userId) {
    await ctx.reply(
      'Este chat n’o estÿ vinculado. No app/PWA, gere um c½digo e envie: /link SEU_CODIGO',
      { reply_markup: buildMenuKeyboard() },
    );
    return;
  }

  await ctx.reply(`Chat vinculado ao usuÿrio #${userId}.`, { reply_markup: buildMenuKeyboard() });
}

export function registerCommandHandlers(bot: Bot) {
  bot.command('start', async (ctx) => {
    requireTelegramId(ctx);
    const user = await getAdminUser();
    await ensureDefaultCategory(user.id);
    await ctx.reply(
      'Ol ! Envie um texto com seu gasto, ex: "mercado 128,90" ou "pix 60 pro JoÆo categoria servi‡os".\n\nUse os botäes abaixo para atalhos r pidos ou apenas mande o gasto em texto. O bot vai pedir confirma‡Æo antes de salvar.',
      { reply_markup: buildMenuKeyboard() },
    );
  });

  bot.command('menu', async (ctx) => {
    await ctx.reply('Menu ativado.', { reply_markup: buildMenuKeyboard() });
  });

  bot.command('ocultar_menu', async (ctx) => {
    await ctx.reply('Menu ocultado. Use /menu para mostrar novamente.', { reply_markup: removeMenuKeyboard() });
  });

  bot.command(['limpar', 'limpar_tela'], async (ctx) => {
    await handleClearScreen(ctx);
  });

  bot.command('ajuda', async (ctx) => {
    await sendAjuda(ctx);
  });

  bot.command('categorias', async (ctx) => {
    try {
      await sendCategorias(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro ao listar categorias.';
      await ctx.reply(message);
    }
  });

  bot.command('relatorio', async (ctx) => {
    await handleRelatorioCommand(ctx);
  });

  bot.command('despesas', async (ctx) => {
    await handleDespesasCommand(ctx);
  });

  bot.command('despesa', async (ctx) => {
    try {
      requireTelegramId(ctx);
      const input = (ctx.match as string | undefined)?.trim() ?? '';
      if (!input) {
        await ctx.reply('Use: /despesa VALOR descricao [DATA opcional DD/MM ou DD/MM/AAAA]', {
          reply_markup: buildMenuKeyboard(),
        });
        return;
      }

      const parsed = parseExpenseText(input);
      const { draft } = await createDraftFromParsed(BOT_USER_KEY, parsed);
      const confirmed = await confirmDraft(draft.id, BOT_USER_KEY);
      if (!confirmed) {
        await ctx.reply('NÆo consegui salvar a despesa.', { reply_markup: buildMenuKeyboard() });
        return;
      }

      await ctx.reply(
        `Despesa registrada em ${formatDate(confirmed.expense.date)}: ${formatCurrency(confirmed.expense.amountCents)} - ${confirmed.expense.description} (ID #${confirmed.expense.id})`,
        { reply_markup: buildMenuKeyboard() },
      );
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'NÆo consegui registrar. Reenvie como: /despesa VALOR descricao [DATA opcional DD/MM ou DD/MM/AAAA].';
      await ctx.reply(message, { reply_markup: buildMenuKeyboard() });
    }
  });

  bot.command('editar', async (ctx) => {
    try {
      requireTelegramId(ctx);
      const args = (ctx.match as string | undefined)?.trim();
      if (!args) {
        await ctx.reply('Formato: /editar ID campo novo_valor', { reply_markup: buildMenuKeyboard() });
        return;
      }

      const [idStr, field, ...rest] = args.split(' ');
      const expenseId = Number.parseInt(idStr, 10);
      if (Number.isNaN(expenseId)) {
        await ctx.reply('ID inv lido. Ex: /editar 12 valor 40,50', { reply_markup: buildMenuKeyboard() });
        return;
      }
      const newValue = rest.join(' ').trim();
      if (!newValue) {
        await ctx.reply('Informe o novo valor. Ex: /editar 12 descricao diesel do trator', {
          reply_markup: buildMenuKeyboard(),
        });
        return;
      }

      const fieldName = field?.toLowerCase();
      if (fieldName === 'valor') {
        const amountCents = amountStringToCents(newValue);
        if (amountCents === null) {
          await ctx.reply('Valor inv lido. Use formatos como 40 ou 40,50.', { reply_markup: buildMenuKeyboard() });
          return;
        }
        const result = await updateExpenseAmount(BOT_USER_KEY, expenseId, amountCents);
        if (!result) {
          await ctx.reply('Despesa nÆo encontrada.', { reply_markup: buildMenuKeyboard() });
          return;
        }
        await ctx.reply(
          `Atualizado valor para ${formatCurrency(result.expense.amountCents)} - ID #${result.expense.id}`,
          { reply_markup: buildMenuKeyboard() },
        );
      } else if (fieldName === 'descricao' || fieldName === 'descri‡Æo') {
        const result = await updateExpenseDescription(BOT_USER_KEY, expenseId, newValue);
        if (!result) {
          await ctx.reply('Despesa nÆo encontrada.', { reply_markup: buildMenuKeyboard() });
          return;
        }
        await ctx.reply(`Descri‡Æo atualizada para "${result.expense.description}" - ID #${result.expense.id}`, {
          reply_markup: buildMenuKeyboard(),
        });
      } else if (fieldName === 'categoria') {
        const result = await updateExpenseCategory(BOT_USER_KEY, expenseId, newValue);
        if (!result) {
          await ctx.reply('Despesa nÆo encontrada.', { reply_markup: buildMenuKeyboard() });
          return;
        }
        await ctx.reply(`Categoria atualizada para ${result.expense.category.name} - ID #${result.expense.id}`, {
          reply_markup: buildMenuKeyboard(),
        });
      } else if (fieldName === 'data') {
        const parsedDate = parseDateFromText(newValue);
        if (!parsedDate) {
          await ctx.reply('Data inv lida. Use hoje, ontem, 25/12 ou 25/12/2025.', {
            reply_markup: buildMenuKeyboard(),
          });
          return;
        }
        const normalized = dayjs(parsedDate.date).tz(TZ).startOf('day').toDate();
        const result = await updateExpenseDate(BOT_USER_KEY, expenseId, normalized);
        if (!result) {
          await ctx.reply('Despesa nÆo encontrada.', { reply_markup: buildMenuKeyboard() });
          return;
        }
        await ctx.reply(`Data atualizada para ${formatDate(result.expense.date)} - ID #${result.expense.id}`, {
          reply_markup: buildMenuKeyboard(),
        });
      } else {
        await ctx.reply('Campos aceitos: valor, descricao, categoria, data', {
          reply_markup: buildMenuKeyboard(),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro ao editar despesa.';
      await ctx.reply(message);
    }
  });

  bot.command('remover', async (ctx) => {
    try {
      requireTelegramId(ctx);
      const args = (ctx.match as string | undefined)?.trim();
      if (!args) {
        await ctx.reply('Use: /remover ID', { reply_markup: buildMenuKeyboard() });
        return;
      }

      const expenseId = Number.parseInt(args.split(' ')[0], 10);
      if (Number.isNaN(expenseId)) {
        await ctx.reply('ID inv lido.', { reply_markup: buildMenuKeyboard() });
        return;
      }

      const result = await deleteExpense(BOT_USER_KEY, expenseId);
      if (!result) {
        await ctx.reply('Despesa nÆo encontrada para este usu rio.', { reply_markup: buildMenuKeyboard() });
        return;
      }

      await ctx.reply(
        `Despesa removida: ${formatCurrency(result.expense.amountCents)} - ${result.expense.description} - ID #${result.expense.id}`,
        { reply_markup: buildMenuKeyboard() },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro ao remover despesa.';
      await ctx.reply(message);
    }
  });

  bot.command('limpar_despesas', async (ctx) => {
    requireTelegramId(ctx);
    const args = (ctx.match as string | undefined)?.trim().toLowerCase() ?? '';
    const match = args.match(/(\d{1,2})\/(\d{4})/);
    if (!match) {
      await ctx.reply('Use: /limpar_despesas MM/AAAA', { reply_markup: buildMenuKeyboard() });
      return;
    }
    const month = Number.parseInt(match[1], 10);
    const year = Number.parseInt(match[2], 10);
    if (month < 1 || month > 12) {
      await ctx.reply('Mˆs inv lido. Use MM/AAAA.', { reply_markup: buildMenuKeyboard() });
      return;
    }

    const ymKey = `${year}-${String(month).padStart(2, '0')}`;
    await setSession(BOT_USER_KEY, 'confirm:delete', ymKey);

    await ctx.reply(
      `Tem certeza que deseja apagar as despesas de ${match[1].padStart(2, '0')}/${year}?` +
        `\nDigite: APAGAR ${match[1].padStart(2, '0')}/${year} para confirmar.`,
      { reply_markup: buildMenuKeyboard() },
    );
  });

  bot.command('reset_total', async (ctx) => {
    try {
      await handleResetTotalCommand(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro ao iniciar reset.';
      await ctx.reply(message, { reply_markup: buildMenuKeyboard() });
    }
  });

  bot.command('salario', async (ctx) => {
    try {
      await handleSalarioCommand(ctx);
    } catch {
      await ctx.reply('Erro ao salvar sal rio. Tente novamente.', { reply_markup: buildMenuKeyboard() });
    }
  });

  bot.command('extra', async (ctx) => {
    try {
      await handleExtraCommand(ctx);
    } catch {
      await ctx.reply('Erro ao salvar extra. Tente novamente.', { reply_markup: buildMenuKeyboard() });
    }
  });

  bot.command('fixa', async (ctx) => {
    try {
      await handleFixaCommand(ctx);
    } catch {
      await ctx.reply('Erro ao salvar conta fixa. Tente novamente.', { reply_markup: buildMenuKeyboard() });
    }
  });

  bot.command('planejamento', async (ctx) => {
    try {
      await handlePlanejamentoCommand(ctx);
    } catch {
      await ctx.reply('Erro ao carregar planejamento. Tente novamente.', { reply_markup: buildMenuKeyboard() });
    }
  });

  bot.command('link', async (ctx) => {
    try {
      await handleLinkCommand(ctx);
    } catch {
      await ctx.reply('Erro ao vincular Telegram. Tente novamente.', { reply_markup: buildMenuKeyboard() });
    }
  });

  bot.command('me', async (ctx) => {
    try {
      await handleMeCommand(ctx);
    } catch {
      await ctx.reply('Erro ao consultar vinculaÎ’o.', { reply_markup: buildMenuKeyboard() });
    }
  });

  bot.command(['id', 'debugid'], async (ctx) => {
    const chatId = ctx.chat?.id;
    const fromId = ctx.from?.id;
    const type = ctx.chat?.type;

    let linkInfo: {
      linkId: number;
      linkedUserId: number;
      linkedTelegramId: string;
      chatId: string | null;
      createdAt: Date;
    } | null = null;

    const candidates: string[] = [];
    if (typeof chatId !== 'undefined') candidates.push(String(chatId));
    if (typeof fromId !== 'undefined' && (!chatId || chatId !== fromId)) candidates.push(String(fromId));

    for (const candidate of candidates) {
      const user = await prisma.user.findFirst({
        where: { telegramChatId: candidate },
        select: { id: true, telegramId: true, telegramChatId: true, createdAt: true },
      });
      if (user) {
        linkInfo = {
          linkId: user.id,
          linkedUserId: user.id,
          linkedTelegramId: user.telegramId,
          chatId: user.telegramChatId,
          createdAt: user.createdAt,
        };
        break;
      }
    }

    const lines = [
      `chatId: ${chatId ?? 'n/a'}`,
      `fromId: ${fromId ?? 'n/a'}`,
      `chatType: ${type ?? 'n/a'}`,
    ];

    if (linkInfo) {
      lines.push(
        `vinculo: linkId=${linkInfo.linkId} userId=${linkInfo.linkedUserId} telegramId=${linkInfo.linkedTelegramId} chatId=${linkInfo.chatId} createdAt=${linkInfo.createdAt.toISOString()}`,
      );
    } else {
      lines.push('vinculo: nao encontrado');
    }

    await ctx.reply(lines.join('\n'), { reply_markup: buildMenuKeyboard() });
  });
}
