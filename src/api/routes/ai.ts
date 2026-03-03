import { Router } from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";

import { AuthedRequest } from "../middleware/auth";
import {
  tool_getDashboardSummary,
  tool_getPlanning,
  tool_getOpenInvoices,
  tool_getTopEntries,
} from "../../services/aiToolService";
import { dayjs, TZ } from "../../utils/dates";
import { formatCurrency } from "../../utils/money";
import { GoogleGenerativeAI } from "@google/generative-ai";

const prisma = new PrismaClient();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
const aiModel = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: { responseMimeType: "application/json" },
});

const router = Router();
const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const requestSchema = z.object({
  message: z.string().min(1),
  month: z.string().regex(MONTH_PATTERN).optional(),
  conversationId: z.string().optional(),
});

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

  // Gráfico da IA
  cards.push({
    type: "chart",
    title: "Gastos por Categoria",
    data: summary.totalPorCategoria.slice(0, 4).map(item => ({
      name: item.category,
      value: item.total
    }))
  });

  if (topEntries.length) {
    cards.push({
      type: "list",
      title: "Maiores gastos do mês",
      data: {
        items: topEntries.map((entry) => {
          const valueInCents = Math.round(entry.amount * 100); 
          return {
            title: entry.description,
            subtitle: `${entry.category} • ${entry.date}`,
            value: valueInCents,
            formattedValue: formatCurrency(valueInCents),
          };
        }),
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
            formattedRemaining: new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(invoice.remaining),
            dueDate: invoice.dueDate,
            purchases: invoice.purchases 
          })),
          totalRemaining: openInvoices.reduce((sum, invoice) => sum + invoice.remaining, 0),
          formattedTotalRemaining: new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(openInvoices.reduce((sum, invoice) => sum + invoice.remaining, 0)),
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
    { id: "ai-top-expenses", label: "Ver maiores gastos", payload: { kind: "topEntries", month: targetMonth } },
    { id: "ai-compare-month", label: "Comparar com mês passado", payload: { kind: "compareMonth", month: previousMonth } }
  ];

  const baseMessage = `No mês de ${targetMonth} você teve ${summary.expensesCount} lançamentos, totalizando ${formatCurrency(summary.totalExpensesCents)}. O saldo em conta está em ${formatCurrency(summary.balanceCents)}.`;
  let assistantMessage = baseMessage;
  
  if (asksForCards && invoicesResponse && invoicesResponse.length) {
    const openCount = invoicesResponse.filter((invoice) => invoice.remaining > 0).length;
    assistantMessage += ` Há ${openCount} fatura(s) com valores pendentes.`;
  }

  return { assistantMessage, cards, suggestedActions, toolsUsed: Array.from(toolsUsed) };
}

router.post("/chat", async (req: AuthedRequest, res) => {
  const validation = requestSchema.safeParse(req.body ?? {});
  if (!validation.success) return res.status(400).json({ error: "Corpo inválido" });

  const { message, conversationId: providedId } = validation.data;
  const user = req.user;
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const conversationId = providedId || randomUUID();
  const currentMonth = dayjs().tz(TZ).format("YYYY-MM");
  const lastMonth = dayjs().tz(TZ).subtract(1, "month").format("YYYY-MM");

  try {
    const userCategories = await prisma.category.findMany({ where: { userId: user.id } });
    const categoryNames = userCategories.map(c => c.name).join(", ");

    const prompt = `
      Você é um consultor financeiro inteligente do app "Financio". Mês atual: ${currentMonth}.
      O usuário possui estas categorias: [${categoryNames || "Nenhuma ainda"}].
      Mensagem do usuário: "${message}"

      Seu objetivo é analisar o texto e retornar APENAS um objeto JSON válido, sem usar \`\`\`json.

      Regras de Intenção (intent):
      1. "chat": Saudação, dúvidas gerais.
      2. "expense": Registrar um gasto numérico. Se a categoria não existir, CRIE UMA NOVA IDEAL. Dê conselhos financeiros se achar o gasto fútil.
      3. "dashboard": Pedir para ver relatórios, resumos.
      4. "delete_last": O usuário pediu para apagar ou desfazer o último lançamento.
      5. "compare": O usuário pediu para comparar os gastos entre dois meses (ex: "gastei mais esse mês do que o passado?", "comparar março e fevereiro").

      Formato de Saída OBRIGATÓRIO (Mapeie method para CREDIT, PIX, DEBIT, CASH, TRANSFER ou OTHER):
      {
        "intent": "chat" | "expense" | "dashboard" | "delete_last" | "compare",
        "targetMonth": "${currentMonth}", 
        "compareMonth": "${lastMonth}", 
        "reply": "Sua resposta humana aqui",
        "expenseDetails": { "description": "Nome", "amount": 0, "method": "PIX", "category": "NomeDaCategoria" }
      }
    `;

    const result = await aiModel.generateContent(prompt);
    let textoResposta = result.response.text().trim();
    textoResposta = textoResposta.replace(/```json/g, "").replace(/```/g, "").trim();
    
    const aiDecision = JSON.parse(textoResposta);

    // --- INTENÇÃO: APAGAR ÚLTIMO ---
    if (aiDecision.intent === "delete_last") {
      try {
        const lastExpense = await prisma.expense.findFirst({
          where: { userId: user.id },
          orderBy: { id: 'desc' }
        });
        if (!lastExpense) {
          return res.status(200).json({ conversationId, assistantMessage: "Não encontrei nenhum lançamento recente seu para apagar! 🧐", cards: [] });
        }
        await prisma.expense.delete({ where: { id: lastExpense.id } });
        return res.status(200).json({
          conversationId,
          assistantMessage: `🗑️ Feito! Eu apaguei o último lançamento que você fez (**${lastExpense.description}** de R$ ${(lastExpense.amountCents / 100).toFixed(2)}).`,
          cards: [], suggestedActions: []
        });
      } catch (err) {
        return res.status(200).json({ conversationId, assistantMessage: "Tive um problema ao tentar apagar o lançamento.", cards: [] });
      }
    }

    // --- NOVA INTENÇÃO: COMPARAÇÃO ENTRE MESES ---
    if (aiDecision.intent === "compare") {
      try {
        const month1 = aiDecision.targetMonth || currentMonth;
        const month2 = aiDecision.compareMonth || lastMonth;

        const summary1 = await tool_getDashboardSummary(user.id, month1);
        const summary2 = await tool_getDashboardSummary(user.id, month2);

        const diffCents = summary1.totalExpensesCents - summary2.totalExpensesCents;
        const economizou = diffCents <= 0;
        const diffFormatada = formatCurrency(Math.abs(diffCents));

        let resposta = aiDecision.reply;
        if (!resposta || resposta.length < 10) {
          resposta = economizou 
            ? `Parabéns! 🥳 Você gastou **${diffFormatada} a menos** em ${month1} comparado a ${month2}. Continue assim!`
            : `Atenção! 🚨 Você gastou **${diffFormatada} a mais** em ${month1} comparado a ${month2}. Vamos segurar os gastos?`;
        }

        const cards = [{
          type: "metric",
          title: `Comparativo: ${month1} vs ${month2}`,
          data: {
            // Se economizou, fica positivo (verde). Se gastou mais, fica negativo (vermelho)
            value: economizou ? Math.abs(diffCents) : -Math.abs(diffCents), 
            currency: "BRL",
            detail: `${month1}: ${formatCurrency(summary1.totalExpensesCents)}\n${month2}: ${formatCurrency(summary2.totalExpensesCents)}`
          }
        }];

        return res.status(200).json({
          conversationId,
          assistantMessage: resposta,
          cards,
          suggestedActions: [{ label: "Ver resumo do mês" }]
        });
      } catch (err) {
        return res.status(200).json({ conversationId, assistantMessage: "Deu um errinho ao buscar a comparação dos meses no banco.", cards: [] });
      }
    }

    // --- INTENÇÃO: DASHBOARD ---
    if (aiDecision.intent === "dashboard") {
      const payload = await buildAssistantResponse(user.id, aiDecision.targetMonth, message);
      return res.status(200).json({
        conversationId,
        assistantMessage: aiDecision.reply || payload.assistantMessage,
        cards: payload.cards,
        suggestedActions: payload.suggestedActions,
      });
    }

    // --- INTENÇÃO: REGISTRAR DESPESA ---
    if (aiDecision.intent === "expense") {
      try {
        const amountCents = Math.round(aiDecision.expenseDetails.amount * 100);
        const categoryName = aiDecision.expenseDetails.category || "Outros";
        const normalizedName = categoryName.toLowerCase().trim();
        
        let category = await prisma.category.findFirst({
          where: { userId: user.id, normalizedName }
        });

        if (!category) {
          category = await prisma.category.create({
            data: { userId: user.id, name: categoryName, normalizedName }
          });
        }

        await prisma.expense.create({
          data: {
            userId: user.id,
            categoryId: category.id,
            amountCents: amountCents,
            paymentMethod: aiDecision.expenseDetails.method,
            description: aiDecision.expenseDetails.description,
            date: new Date(),
            source: 'AI_CHAT',
            rawText: message
          }
        });

        return res.status(200).json({
          conversationId,
          assistantMessage: `${aiDecision.reply}\n\n✅ Lançamento salvo!\n🛒 **${aiDecision.expenseDetails.description}**\n💰 R$ ${aiDecision.expenseDetails.amount.toFixed(2)}\n📂 ${categoryName}`,
          cards: [],
          suggestedActions: [{ label: "Desfazer último" }, { label: "Comparar com mês passado" }]
        });
      } catch (dbError) {
        return res.status(200).json({ conversationId, assistantMessage: "Entendi o gasto, mas ocorreu um erro no banco ao salvar.", cards: [] });
      }
    }

    // --- "chat" ---
    return res.status(200).json({
      conversationId,
      assistantMessage: aiDecision.reply,
      cards: [],
      suggestedActions: [{ label: "Ver resumos" }]
    });

  } catch (err) {
    return res.status(200).json({ conversationId, assistantMessage: "Tive um problema de processamento. Tente novamente.", cards: [] });
  }
});

export default router;