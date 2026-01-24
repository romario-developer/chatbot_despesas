import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import dayjs from 'dayjs';

import { AuthedRequest } from '../middleware/auth';
import { parseExpenseText } from '../../services/parseExpenseText';
import { createExpense } from '../../services/expenseService';
import { tool_getDashboardSummary, tool_getTopEntries, tool_getOpenInvoices, tool_getPlanning } from '../../services/aiToolService';
import { TZ, dayjs as sharedDayjs } from '../../utils/dates';
import { centsToNumber } from '../../utils/money';

const router = Router();

const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const GREETING_KEYWORDS = ['oi', 'ola', 'olá', 'oie', 'e aí', 'e ai', 'bom dia', 'boa tarde', 'boa noite'];

const chatSchema = z.object({
  message: z.string().min(1),
  month: z.string().regex(MONTH_PATTERN).optional(),
  conversationId: z.string().optional(),
});

function includesGreeting(text: string) {
  const normalized = text.trim().toLowerCase();
  return GREETING_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function looksLikeQuickEntry(text: string) {
  const numeric = text.match(/-?\\d+(?:[.,]\\d{1,2})?/g);
  if (!numeric?.length) return false;
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length <= 8;
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

function ensureArrays(target: any) {
  target.cards = Array.isArray(target.cards) ? target.cards : [];
  target.suggestedActions = Array.isArray(target.suggestedActions) ? target.suggestedActions : [];
  return target;
}

router.post('/chat', async (req: AuthedRequest, res) => {
  const validation = chatSchema.safeParse(req.body ?? {});
  if (!validation.success) {
    return res.status(400).json({ error: 'Corpo inválido', details: validation.error.format() });
  }

  const { message, month, conversationId } = validation.data;
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const convId = conversationId || randomUUID();
  const normalized = message.trim().toLowerCase();
  const targetMonth = month && MONTH_PATTERN.test(month) ? month : sharedDayjs().tz(TZ).format('YYYY-MM');
  let responseBody: any = {
    conversationId: convId,
    assistantMessage: 'Desculpa, ainda estou aprendendo.',
    cards: [],
    suggestedActions: [],
    state: { month: month ?? null, topic: 'unknown', pendingQuestion: 'none' },
  };

  const quickEntry = looksLikeQuickEntry(message);
  const kind = quickEntry ? 'entry' : 'insight';
  if (process.env.NODE_ENV !== 'production') {
    console.log('[assistant]', { userId, kind, month: month ?? targetMonth });
  }

  if (quickEntry) {
    try {
      const parsed = parseExpenseText(message);
      const created = await createExpense(userId, {
        amountCents: parsed.amountCents,
        categoryName: parsed.categoryName,
        description: parsed.description,
        date: parsed.date,
        rawText: parsed.rawText,
      });
      responseBody.assistantMessage = `Registrei: ${created.category.name} — ${formatCurrency(
        centsToNumber(parsed.amountCents),
      )} em ${created.category.name}. Quer ajustar algo?`;
      responseBody.suggestedActions = [
        { id: 'ai-edit-category', label: 'Editar categoria', payload: { kind: 'editCategory', entryId: created.expense.id } },
        { id: 'ai-change-payment', label: 'Trocar forma de pagamento', payload: { kind: 'changePayment', entryId: created.expense.id } },
        { id: 'ai-undo-entry', label: 'Desfazer', payload: { kind: 'undoEntry', entryId: created.expense.id } },
      ];
      responseBody.state.month = targetMonth;
      responseBody.state.pendingQuestion = 'none';
      return res.status(200).json(ensureArrays(responseBody));
    } catch (err: any) {
      const message = err instanceof Error ? err.message : 'Não foi possível interpretar o lançamento.';
      responseBody.assistantMessage = message;
      return res.status(422).json(ensureArrays(responseBody));
    }
  }

  if (includesGreeting(message)) {
    responseBody.assistantMessage =
      'Oi! Quer analisar saldo, gastos, cartões ou planejamento? Qual mês você quer ver?';
    responseBody.state.pendingQuestion = 'askMonth';
    return res.status(200).json(ensureArrays(responseBody));
  }

  try {
    const summary = await tool_getDashboardSummary(userId, targetMonth);
    const topEntries = await tool_getTopEntries(userId, targetMonth, 5);
    const invoices = await tool_getOpenInvoices(userId);
    const planning = await tool_getPlanning(userId);

    const cards: Array<Record<string, any>> = [];
    cards.push({
      type: 'metric',
      title: `Saldo (${targetMonth})`,
      data: {
        value: summary.balance,
        currency: 'BRL',
        detail: `Receitas ${formatCurrency(summary.receitas)} • Gastos ${formatCurrency(
          summary.totalExpenses,
        )} • Em conta ${formatCurrency(summary.saldoEmConta)}`,
      },
    });
    if (summary.totalPorCategoria.length) {
      cards.push({
        type: 'list',
        title: 'Top categorias',
        data: {
          items: summary.totalPorCategoria.slice(0, 3).map((item) => ({
            title: item.category,
            value: item.total,
            formattedValue: formatCurrency(item.total),
            percent: Number(((item.total / (summary.totalExpenses || 1)) * 100).toFixed(1)),
          })),
        },
      });
    }
    if (topEntries.length) {
      cards.push({
        type: 'list',
        title: 'Maiores gastos',
        data: {
          items: topEntries.map((entry) => ({
            title: entry.description,
            subtitle: `${entry.category} • ${entry.date}`,
            value: entry.amount,
            formattedValue: formatCurrency(entry.amount),
          })),
        },
      });
    }
    const openInvoices = invoices.filter((invoice) => invoice.remaining > 0);
    if (openInvoices.length) {
      const totalRemaining = openInvoices.reduce((sum, invoice) => sum + invoice.remaining, 0);
      cards.push({
        type: 'summary',
        title: 'Faturas em aberto',
        data: {
          invoices: openInvoices.map((invoice) => ({
            cardName: invoice.cardName,
            remaining: invoice.remaining,
            dueDate: invoice.dueDate,
          })),
          totalRemaining,
          formattedTotalRemaining: formatCurrency(totalRemaining),
        },
      });
    }

    const plannedSalary = planning.salaryByMonth[targetMonth] ?? 0;
    const plannedExtras = (planning.extrasByMonth[targetMonth] ?? []).reduce((sum, item) => sum + item.amount, 0);
    const plannedTotal = plannedSalary + plannedExtras;
    cards.push({
      type: 'metric',
      title: 'Planejamento',
      data: {
        value: plannedTotal - summary.totalExpenses,
        currency: 'BRL',
        detail: `Planejado ${formatCurrency(plannedTotal)} • Realizado ${formatCurrency(
          summary.totalExpenses,
        )}`,
      },
    });
    responseBody.assistantMessage = `No mês de ${targetMonth} você lançou ${summary.expensesCount} itens, gastou ${formatCurrency(
      summary.totalExpenses,
    )} e planejou ${formatCurrency(plannedTotal)}.`;
    responseBody.cards = cards;
    responseBody.suggestedActions = [
      { id: 'ai-top-expenses', label: 'Ver 10 maiores gastos', payload: { kind: 'topEntries', month: targetMonth } },
      { id: 'ai-open-invoices', label: 'Mostrar faturas em aberto', payload: { kind: 'openInvoices' } },
      { id: 'ai-planning', label: 'Comparar com planejamento', payload: { kind: 'planning', month: targetMonth } },
    ];
    responseBody.state.month = targetMonth;
    return res.status(200).json(ensureArrays(responseBody));
  } catch (err) {
    console.error('[assistant] insight error', err);
    responseBody.assistantMessage = 'Não consegui gerar insights agora. Tente mais tarde.';
    return res.status(200).json(ensureArrays(responseBody));
  }
});

export default router;
