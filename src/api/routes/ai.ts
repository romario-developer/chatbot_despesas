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

// Inicializa o Prisma e a IA do Google
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
            // 👇 CORREÇÃO DO BUG DOS R$ 7,51 AQUI 👇
            formattedRemaining: new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(invoice.remaining),
            dueDate: invoice.dueDate,
            purchases: invoice.purchases 
          })),
          totalRemaining: openInvoices.reduce((sum, invoice) => sum + invoice.remaining, 0),
          // 👇 CORREÇÃO DO BUG DO TOTAL GERAL AQUI 👇
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
    { id: "ai-top-expenses", label: "Ver 10 maiores gastos", payload: { kind: "topEntries", month: targetMonth } },
    { id: "ai-compare-month", label: "Comparar com mês anterior", payload: { kind: "compareMonth", month: previousMonth } },
    { id: "ai-show-open-invoices", label: "Mostrar faturas em aberto", payload: { kind: "openInvoices" } },
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

  try {
    const prompt = `
      Você é a inteligência artificial do aplicativo financeiro "ChatDespesas". 
      Mês atual: ${currentMonth}. Mensagem do usuário: "${message}"

      Sua tarefa é agir como uma pessoa real, simpática e inteligente. Retorne APENAS um objeto JSON válido, sem \`\`\`.

      Regras de Classificação ("intent"):
      1. "chat": Saudação, dúvidas gerais, ou relatar gasto SEM valor numérico.
      2. "expense": Gasto contendo OBRIGATORIAMENTE valor numérico e descrição ("gastei 50 de gasolina").
      3. "dashboard": Pedir para ver relatórios, resumos, saldos ou gráficos.

      Formato de Saída OBRIGATÓRIO (Mapeie o método de pagamento EXATAMENTE para as opções do method):
      {
        "intent": "chat" | "expense" | "dashboard",
        "targetMonth": "${currentMonth}",
        "reply": "Resposta natural e empática. Se for lançar despesa, comemore e confirme os dados.",
        "expenseDetails": { 
          "description": "nome do gasto", 
          "amount": 0, 
          "method": "CREDIT" | "PIX" | "DEBIT" | "CASH" | "TRANSFER" | "OTHER",
          "category": "Alimentação" | "Transporte" | "Lazer" | "Saúde" | "Casa" | "Outros"
        }
      }
    `;

    const result = await aiModel.generateContent(prompt);
    let textoResposta = result.response.text().trim();
    textoResposta = textoResposta.replace(/```json/g, "").replace(/```/g, "").trim();
    
    const aiDecision = JSON.parse(textoResposta);

    if (aiDecision.intent === "dashboard") {
      const payload = await buildAssistantResponse(user.id, aiDecision.targetMonth, message);
      return res.status(200).json({
        conversationId,
        assistantMessage: aiDecision.reply || payload.assistantMessage,
        cards: payload.cards,
        suggestedActions: payload.suggestedActions,
      });
    }

    if (aiDecision.intent === "expense") {
      try {
        const amountCents = Math.round(aiDecision.expenseDetails.amount * 100);
        
        // 1. Busca ou Cria a Categoria dinamicamente
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

        // 2. Salva a despesa oficial no banco com todos os campos obrigatórios
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
          assistantMessage: `${aiDecision.reply}\n\n✅ Lançamento salvo com sucesso!\n🛒 **${aiDecision.expenseDetails.description}**\n💰 R$ ${aiDecision.expenseDetails.amount.toFixed(2)}\n📂 ${categoryName}`,
          cards: [],
          suggestedActions: [{ label: "Ver resumo do mês" }, { label: "Lançar outro" }]
        });
        
      } catch (dbError) {
        console.error("❌ Erro do Prisma ao salvar despesa:", dbError);
        return res.status(200).json({
          conversationId,
          assistantMessage: "Eu entendi o seu gasto, mas ocorreu um erro no banco de dados ao salvar. Veja o terminal.",
          cards: [], suggestedActions: []
        });
      }
    }

    // "chat"
    return res.status(200).json({
      conversationId,
      assistantMessage: aiDecision.reply,
      cards: [],
      suggestedActions: [{ label: "Ver resumos" }]
    });

  } catch (err) {
    console.error("❌ Erro da IA:", err);
    return res.status(200).json({ conversationId, assistantMessage: "Tive um problema de processamento. Tente novamente.", cards: [] });
  }
});

export default router;