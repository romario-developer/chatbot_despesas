import { Router } from "express";
import { randomUUID } from "crypto";
import { z } from "zod";

import { AuthedRequest } from "../middleware/auth";
import {
  tool_getDashboardSummary,
  tool_getPlanning,
  tool_getOpenInvoices,
  tool_getTopEntries,
} from "../../services/aiToolService";
import { dayjs, TZ } from "../../utils/dates";
import { formatCurrency } from "../../utils/money";

const router = Router();
const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const HISTORY_DEPTH = 12;
const DEV_MODE = process.env.NODE_ENV !== "production";

type ConversationMessage = { role: "user" | "assistant"; text: string; at: number };
const conversationHistory = new Map<string, ConversationMessage[]>();

const requestSchema = z.object({
  message: z.string().min(1),
  month: z.string().regex(MONTH_PATTERN).optional(),
  conversationId: z.string().optional(),
});

const monthKeywords = ["mês", "mes", "saldo", "gasto", "despesa", "receita", "cartão", "cartao", "fatura", "planejamento", "meta", "parcela", "parcelas", "comparar", "fechar"];

function pushHistory(id: string, role: "user" | "assistant", text: string) {
  const existing = conversationHistory.get(id) ?? [];
  const next = [...existing, { role, text, at: Date.now() }].slice(-HISTORY_DEPTH);
  conversationHistory.set(id, next);
  return next;
}

function needsMonthClarification(text: string) {
  const normalized = text.toLowerCase();
  return monthKeywords.some((keyword) => normalized.includes(keyword));
}

async function buildAssistantResponse(userId: number, targetMonth: string, message: string) {
  const toolsUsed = new Set<string>();
  const summary = await tool_getDashboardSummary(userId, targetMonth);
  toolsUsed.add("tool_getDashboardSummary");
  const planning = await tool_getPlanning(userId);
  toolsUsed.add("tool_getPlanning");
  const topEntries = await tool_getTopEntries(userId, targetMonth, 5);
  toolsUsed.add("tool_getTopEntries");

  const lower = message.toLowerCase();
  const asksForCards = /cartão|cartao|fatura|parcelas|credito|crédito/.test(lower);
  const asksForPlanning = /planejamento|meta|comparar|corte|previsão|projeção/.test(lower);

  const cards: Array<Record<string, any>> = [];
  cards.push({
    type: "metric",
    title: `Saldo estimado (${targetMonth})`,
    data: {
      value: summary.balanceCents,
      currency: "BRL",
      detail: `Receitas: ${formatCurrency(summary.receitasCents)} • Gastos: ${formatCurrency(summary.totalExpensesCents)} • Em conta: ${formatCurrency(summary.saldoEmContaCents)}`,
    },
  });

  if (summary.totalPorCategoria.length) {
    cards.push({
      type: "list",
      title: "Top categorias",
      data: {
        items: summary.totalPorCategoria.slice(0, 3).map((item) => ({
          title: item.category,
          value: item.total,
          formattedValue: formatCurrency(item.total),
        percent: Number(((item.total / (summary.totalExpensesCents || 1)) * 100).toFixed(1)),
        })),
      },
    });
  }

  if (topEntries.length) {
    cards.push({
      type: "list",
      title: "Maiores gastos do mês",
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

  let invoicesResponse: Awaited<ReturnType<typeof tool_getOpenInvoices>> | undefined;
  if (asksForCards) {
    invoicesResponse = await tool_getOpenInvoices(userId);
    toolsUsed.add("tool_getOpenInvoices");
    const openInvoices = invoicesResponse.filter((invoice) => invoice.remaining > 0);
    if (openInvoices.length) {
      cards.push({
        type: "summary",
        title: "Faturas em aberto",
        data: {
          invoices: openInvoices.map((invoice) => ({
            cardName: invoice.cardName,
            remaining: invoice.remaining,
            formattedRemaining: formatCurrency(invoice.remaining),
            dueDate: invoice.dueDate,
          })),
          totalRemaining: openInvoices.reduce((sum, invoice) => sum + invoice.remaining, 0),
          formattedTotalRemaining: formatCurrency(openInvoices.reduce((sum, invoice) => sum + invoice.remaining, 0)),
        },
      });
    }
  }

  if (asksForPlanning) {
    const planned = planning.salaryByMonth[targetMonth] ?? 0;
    const extras = (planning.extrasByMonth[targetMonth] ?? []).reduce((sum, item) => sum + item.amount, 0);
    const plannedTotal = planned + extras;
    const difference = plannedTotal - summary.totalExpensesCents;
    cards.push({
      type: "metric",
      title: "Planejamento mensal",
      data: {
        value: difference,
        currency: "BRL",
    detail: `Planejado: ${formatCurrency(plannedTotal)} • Realizado: ${formatCurrency(summary.totalExpensesCents)}`,
      },
    });
  }

  const previousMonth = dayjs(`${targetMonth}-01`).tz(TZ).subtract(1, "month").format("YYYY-MM");
  const suggestedActions = [
    { id: "ai-top-expenses", label: "Ver 10 maiores gastos", payload: { kind: "topEntries", month: targetMonth } },
    { id: "ai-compare-month", label: "Comparar com mês anterior", payload: { kind: "compareMonth", month: previousMonth } },
    { id: "ai-show-open-invoices", label: "Mostrar faturas em aberto", payload: { kind: "openInvoices" } },
  ];

  const baseMessage = `No mês de ${targetMonth} você teve ${summary.expensesCount} lançamentos, totalizando ${formatCurrency(summary.totalExpensesCents)}. O saldo em conta está em ${formatCurrency(summary.balanceCents)}.`;
  let assistantMessage = baseMessage;
  if (asksForCards && invoicesResponse && invoicesResponse.length) {
    const openCount = invoicesResponse.filter((invoice) => invoice.remaining > 0).length;
    assistantMessage += ` Há ${openCount} fatura(s) com valores pendentes, totalizando ${formatCurrency(
      invoicesResponse.reduce((sum, invoice) => sum + invoice.remaining, 0),
    )}.`;
  }
  if (asksForPlanning) {
    assistantMessage += ` Você planejou ${formatCurrency(
      (planning.salaryByMonth[targetMonth] ?? 0) + (planning.extrasByMonth[targetMonth] ?? []).reduce((sum, item) => sum + item.amount, 0),
    )} neste mês.`;
  }

  const result = {
    assistantMessage,
    cards,
    suggestedActions,
    toolsUsed: Array.from(toolsUsed),
  };
  return result;
}

router.post("/chat", async (req: AuthedRequest, res) => {
  const validation = requestSchema.safeParse(req.body ?? {});
  if (!validation.success) {
    return res.status(400).json({ error: "Corpo inválido" });
  }

  const { message, month: providedMonth, conversationId: providedId } = validation.data;
  const user = req.user;
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const currentMonth = dayjs().tz(TZ).format("YYYY-MM");
  const conversationId = providedId || randomUUID();
  pushHistory(conversationId, "user", message);

  if (!providedMonth && needsMonthClarification(message)) {
    const clarification = `Para responder com números reais, me diga qual mês você quer analisar (formato YYYY-MM). Posso usar ${currentMonth} como padrão.`;
    pushHistory(conversationId, "assistant", clarification);
    return res.status(200).json({
      conversationId,
      assistantMessage: clarification,
      cards: [],
      suggestedActions: [
        { id: "ai-set-month", label: `Usar ${currentMonth}`, payload: { kind: "setMonth", month: currentMonth } },
      ],
      debug: DEV_MODE ? { toolsUsed: [] } : undefined,
    });
  }

  const targetMonth = providedMonth || currentMonth;
  try {
    const payload = await buildAssistantResponse(user.id, targetMonth, message);
    pushHistory(conversationId, "assistant", payload.assistantMessage);
    const response: any = {
      conversationId,
      assistantMessage: payload.assistantMessage,
      cards: payload.cards,
      suggestedActions: payload.suggestedActions,
    };
    if (DEV_MODE) {
      response.debug = { toolsUsed: payload.toolsUsed };
    }
    return res.status(200).json(response);
  } catch (err) {
    console.error("[ai/chat] erro", err);
    const fallbackMessage = "Não consegui gerar os insights agora, tente novamente em instantes.";
    pushHistory(conversationId, "assistant", fallbackMessage);
    return res.status(200).json({
      conversationId,
      assistantMessage: fallbackMessage,
      cards: [],
      suggestedActions: [],
      debug: DEV_MODE ? { toolsUsed: [] } : undefined,
    });
  }
});

export default router;
