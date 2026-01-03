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
import { getMonthlyExpensesPage, getMonthlyReport } from '../services/reportService';
import { getOrCreateUser } from '../services/userService';
import { ensureDefaultCategory, listCategories } from '../services/categoryService';
import { getPlanningByUserId, upsertPlanning } from '../services/planningService';
import { expensesPaginationKeyboard } from './keyboards';
import { buildMenuKeyboard, MENU_LABELS, removeMenuKeyboard } from './menu';
import { setSession, clearSession } from '../services/sessionService';
import { generateResetToken } from '../services/resetService';

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
    throw new Error('Não consegui identificar o usuário do Telegram.');
  }
  return String(telegramId);
}

function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(text: string, max = 35) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
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
    return '<b>Categorias</b>\n\nSem lançamentos no período.';
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
    return `${escapeHtml(c.name)} — ${formatCurrency(c.totalCents)} (${percent}%)`;
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
  const header = `<b>Despesas — ${monthStr}/${input.year}</b>`;
  const meta = `Página ${input.page} de ${input.totalPages} — Itens ${input.totalCount}`;
  const totalLine = `<b>Total do mês: ${formatCurrency(input.totalCents)}</b>`;

  if (!input.totalCount) {
    return `${header}\n${meta}\n${totalLine}\n\nSem lançamentos neste mês.`;
  }

  const lines = input.items
    .map((e) => {
      const desc = truncate((e.description || '').trim() || 'Sem descrição');
      const line1 = `${e.id} — ${escapeHtml(desc)}`;
      const line2 = `${formatDateShort(e.date)} — ${escapeHtml(e.category.name)} — ${formatCurrency(
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
    'Envie o gasto em texto, o bot cria um rascunho e pede confirmação.\nExemplos: "35 diesel", "mercado 128,90", "pix 60 pro João categoria serviços".',
    { reply_markup: buildMenuKeyboard() },
  );
}

export async function sendCategorias(ctx: any) {
  const telegramId = requireTelegramId(ctx);
  const user = await getOrCreateUser(telegramId);
  await ensureDefaultCategory(user.id);
  const categories = await listCategories(user.id);
  if (!categories.length) {
    await ctx.reply('Nenhuma categoria cadastrada ainda.', { reply_markup: buildMenuKeyboard() });
    return;
  }

  const names = categories.map((c: { name: string }) => `- ${c.name}`).join('\n');
  await ctx.reply(`Categorias:\n${names}`, { reply_markup: buildMenuKeyboard() });
}

export async function handleRelatorioCommand(ctx: any, opts?: { month?: number; year?: number }) {
  try {
    const telegramId = requireTelegramId(ctx);
    const args = (ctx.match as string | undefined)?.trim().toLowerCase() ?? '';
    const now = nowBahia();
    let month = opts?.month ?? now.month() + 1;
    let year = opts?.year ?? now.year();

    if (!opts && args && args !== 'mes') {
      const match = args.match(/(\d{1,2})\/(\d{4})/);
      if (!match) {
        await ctx.reply('Use "mes" ou "MM/AAAA". Ex: /relatorio 12/2025');
        return;
      }
      month = Number.parseInt(match[1], 10);
      year = Number.parseInt(match[2], 10);
    }

    const report = await getMonthlyReport(telegramId, month, year);

    const periodLine = `Período: ${formatDate(report.start)} a ${formatDate(report.end)}`;
    const header = `<b>Relatório — ${String(month).padStart(2, '0')}/${year}</b>`;
    const countLine = `Lançamentos: ${report.expensesCount}`;
    const totalLine = `<b>Total: ${formatCurrency(report.totalCents)}</b>`;

    const categoryBlock = buildCategoryBlock(report.categorySummary, report.totalCents);

    const parts = [header, periodLine, countLine, totalLine, '', categoryBlock];

    const message = parts.join('\n');

    await ctx.reply(message, { parse_mode: 'HTML', reply_markup: buildMenuKeyboard() });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro ao gerar relatório.';
    await ctx.reply(message);
  }
}

export async function handleDespesasCommand(ctx: any, opts?: { month?: number; year?: number }) {
  try {
    const telegramId = requireTelegramId(ctx);
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
    const pageData = await getMonthlyExpensesPage(telegramId, month, year, 1, pageSize);
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
  const telegramId = requireTelegramId(ctx);
  const user = await getOrCreateUser(telegramId);
  const { token } = await generateResetToken(user.id);

  const lines = [
    '⚠️ Isso apagara TODAS as suas despesas, rascunhos e categorias.',
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
  const telegramId = requireTelegramId(ctx);
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

  const user = await getOrCreateUser(telegramId);
  const planning = await getPlanningByUserId(user.id);
  const salaryByMonth = { ...planning.salaryByMonth, [month.key]: amount };
  const updated = { ...planning, salaryByMonth };

  await upsertPlanning(user.id, updated);

  await ctx.reply(`Sal rio de ${month.key} definido para ${formatBRL(amount)}`, {
    reply_markup: buildMenuKeyboard(),
  });
}

async function handleExtraCommand(ctx: any) {
  const telegramId = requireTelegramId(ctx);
  const args = (ctx.match as string | undefined)?.trim().split(/\s+/).filter(Boolean) ?? [];
  const monthArg = args[0];
  const amountArg = args[1];
  const label = args.slice(2).join(' ').trim();

  const month = parseMonthArg(monthArg);
  const amount = parseAmountNumber(amountArg);

  if (!month || amount === null || amount <= 0) {
    await ctx.reply('Use: /extra YYYY-MM valor descri‡Æo(opcional). Ex: /extra 2026-01 250 freela', {
      reply_markup: buildMenuKeyboard(),
    });
    return;
  }

  const user = await getOrCreateUser(telegramId);
  const planning = await getPlanningByUserId(user.id);
  const monthExtras = [...(planning.extrasByMonth[month.key] ?? [])];
  monthExtras.push({ id: generateId(), label: label || undefined, amount });
  const extrasByMonth = { ...planning.extrasByMonth, [month.key]: monthExtras };
  const updated = { ...planning, extrasByMonth };

  await upsertPlanning(user.id, updated);

  const totalExtras = monthExtras.reduce((sum, item) => sum + item.amount, 0);
  await ctx.reply(
    `Extra adicionado. Total de extras em ${month.key}: ${formatBRL(totalExtras)}`,
    { reply_markup: buildMenuKeyboard() },
  );
}

async function handleFixaCommand(ctx: any) {
  const telegramId = requireTelegramId(ctx);
  const args = (ctx.match as string | undefined)?.trim().split(/\s+/).filter(Boolean) ?? [];
  const amountArg = args[0];
  const label = args.slice(1).join(' ').trim();

  const amount = parseAmountNumber(amountArg);
  if (amount === null || amount <= 0) {
    await ctx.reply('Use: /fixa valor descri‡Æo(opcional). Ex: /fixa 120 internet', {
      reply_markup: buildMenuKeyboard(),
    });
    return;
  }

  const user = await getOrCreateUser(telegramId);
  const planning = await getPlanningByUserId(user.id);
  const fixedBills = [...planning.fixedBills, { id: generateId(), label: label || undefined, amount }];
  const updated = { ...planning, fixedBills };

  await upsertPlanning(user.id, updated);

  const totalFixas = fixedBills.reduce((sum, item) => sum + item.amount, 0);
  await ctx.reply(`Conta fixa adicionada. Total de fixas: ${formatBRL(totalFixas)}`, {
    reply_markup: buildMenuKeyboard(),
  });
}

async function handlePlanejamentoCommand(ctx: any) {
  const telegramId = requireTelegramId(ctx);
  const args = (ctx.match as string | undefined)?.trim().split(/\s+/).filter(Boolean) ?? [];
  const maybeMonth = args[0];

  let month = maybeMonth ? parseMonthArg(maybeMonth) : null;
  if (maybeMonth && !month) {
    await ctx.reply('Use: /planejamento YYYY-MM. Ex: /planejamento 2026-01', {
      reply_markup: buildMenuKeyboard(),
    });
    return;
  }

  if (!month) {
    const now = nowBahia();
    month = {
      year: now.year(),
      month: now.month() + 1,
      key: `${now.year()}-${String(now.month() + 1).padStart(2, '0')}`,
    };
  }

  const user = await getOrCreateUser(telegramId);
  const planning = await getPlanningByUserId(user.id);

  const salary = planning.salaryByMonth[month.key] ?? 0;
  const extrasList = planning.extrasByMonth[month.key] ?? [];
  const extras = extrasList.reduce((sum, item) => sum + item.amount, 0);
  const receita = salary + extras;
  const fixas = planning.fixedBills.reduce((sum, item) => sum + item.amount, 0);

  const report = await getMonthlyReport(telegramId, month.month, month.year);
  const gastos = (report.totalCents ?? 0) / 100;
  const saldo = receita - gastos;
  const saldoPrevisto = receita - gastos - fixas;

  const lines = [
    `📅 Planejamento ${month.key}`,
    `Receita: ${formatBRL(receita)}`,
    `- Sal rio: ${formatBRL(salary)}`,
    `- Extras: ${formatBRL(extras)}`,
    `Fixas: ${formatBRL(fixas)}`,
    `Gastos do mˆs: ${formatBRL(gastos)}`,
    `Saldo: ${formatBRL(saldo)}`,
    `Saldo previsto: ${formatBRL(saldoPrevisto)}`,
  ];

  await ctx.reply(lines.join('\n'), { reply_markup: buildMenuKeyboard() });
}

export function registerCommandHandlers(bot: Bot) {
  bot.command('start', async (ctx) => {
    const telegramId = requireTelegramId(ctx);
    const user = await getOrCreateUser(telegramId);
    await ensureDefaultCategory(user.id);
    await ctx.reply(
      'Olá! Envie um texto com seu gasto, ex: "mercado 128,90" ou "pix 60 pro João categoria serviços".\n\nUse os botões abaixo para atalhos rápidos ou apenas mande o gasto em texto. O bot vai pedir confirmação antes de salvar.',
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

  bot.command('editar', async (ctx) => {
    try {
      const telegramId = requireTelegramId(ctx);
      const args = (ctx.match as string | undefined)?.trim();
      if (!args) {
        await ctx.reply('Formato: /editar ID campo novo_valor', { reply_markup: buildMenuKeyboard() });
        return;
      }

      const [idStr, field, ...rest] = args.split(' ');
      const expenseId = Number.parseInt(idStr, 10);
      if (Number.isNaN(expenseId)) {
        await ctx.reply('ID inválido. Ex: /editar 12 valor 40,50', { reply_markup: buildMenuKeyboard() });
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
          await ctx.reply('Valor inválido. Use formatos como 40 ou 40,50.', { reply_markup: buildMenuKeyboard() });
          return;
        }
        const result = await updateExpenseAmount(telegramId, expenseId, amountCents);
        if (!result) {
          await ctx.reply('Despesa não encontrada.', { reply_markup: buildMenuKeyboard() });
          return;
        }
        await ctx.reply(
          `Atualizado valor para ${formatCurrency(result.expense.amountCents)} — ID #${result.expense.id}`,
          { reply_markup: buildMenuKeyboard() },
        );
      } else if (fieldName === 'descricao' || fieldName === 'descrição') {
        const result = await updateExpenseDescription(telegramId, expenseId, newValue);
        if (!result) {
          await ctx.reply('Despesa não encontrada.', { reply_markup: buildMenuKeyboard() });
          return;
        }
        await ctx.reply(`Descrição atualizada para "${result.expense.description}" — ID #${result.expense.id}`, {
          reply_markup: buildMenuKeyboard(),
        });
      } else if (fieldName === 'categoria') {
        const result = await updateExpenseCategory(telegramId, expenseId, newValue);
        if (!result) {
          await ctx.reply('Despesa não encontrada.', { reply_markup: buildMenuKeyboard() });
          return;
        }
        await ctx.reply(`Categoria atualizada para ${result.expense.category.name} — ID #${result.expense.id}`, {
          reply_markup: buildMenuKeyboard(),
        });
      } else if (fieldName === 'data') {
        const parsedDate = parseDateFromText(newValue);
        if (!parsedDate) {
          await ctx.reply('Data inválida. Use hoje, ontem, 25/12 ou 25/12/2025.', {
            reply_markup: buildMenuKeyboard(),
          });
          return;
        }
        const normalized = dayjs(parsedDate.date).tz(TZ).startOf('day').toDate();
        const result = await updateExpenseDate(telegramId, expenseId, normalized);
        if (!result) {
          await ctx.reply('Despesa não encontrada.', { reply_markup: buildMenuKeyboard() });
          return;
        }
        await ctx.reply(`Data atualizada para ${formatDate(result.expense.date)} — ID #${result.expense.id}`, {
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
      const telegramId = requireTelegramId(ctx);
      const args = (ctx.match as string | undefined)?.trim();
      if (!args) {
        await ctx.reply('Use: /remover ID', { reply_markup: buildMenuKeyboard() });
        return;
      }

      const expenseId = Number.parseInt(args.split(' ')[0], 10);
      if (Number.isNaN(expenseId)) {
        await ctx.reply('ID inválido.', { reply_markup: buildMenuKeyboard() });
        return;
      }

      const result = await deleteExpense(telegramId, expenseId);
      if (!result) {
        await ctx.reply('Despesa não encontrada para este usuário.', { reply_markup: buildMenuKeyboard() });
        return;
      }

      await ctx.reply(
        `Despesa removida: ${formatCurrency(result.expense.amountCents)} — ${result.expense.description} — ID #${result.expense.id}`,
        { reply_markup: buildMenuKeyboard() },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro ao remover despesa.';
      await ctx.reply(message);
    }
  });

  bot.command('limpar_despesas', async (ctx) => {
    const telegramId = requireTelegramId(ctx);
    const args = (ctx.match as string | undefined)?.trim().toLowerCase() ?? '';
    const match = args.match(/(\d{1,2})\/(\d{4})/);
    if (!match) {
      await ctx.reply('Use: /limpar_despesas MM/AAAA', { reply_markup: buildMenuKeyboard() });
      return;
    }
    const month = Number.parseInt(match[1], 10);
    const year = Number.parseInt(match[2], 10);
    if (month < 1 || month > 12) {
      await ctx.reply('Mês inválido. Use MM/AAAA.', { reply_markup: buildMenuKeyboard() });
      return;
    }

    const ymKey = `${year}-${String(month).padStart(2, '0')}`;
    await setSession(telegramId, 'confirm:delete', ymKey);

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
}
