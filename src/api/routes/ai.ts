import { Router } from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";

import { AuthedRequest } from "../middleware/auth";
import {
  tool_getDashboardSummary,
  tool_getPlanning,
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
  const topEntries = await tool_getTopEntries(userId, targetMonth, 5);
  toolsUsed.add("tool_getTopEntries");

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
      type: "chart",
      title: "Gastos por Categoria",
      data: summary.totalPorCategoria.slice(0, 4).map(item => ({ name: item.category, value: item.total }))
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

  const suggestedActions = [
    { id: "ai-top-expenses", label: "Ver maiores gastos", payload: { kind: "topEntries", month: targetMonth } },
    { id: "ai-compare-month", label: "Comparar com mês passado", payload: { kind: "compareMonth" } }
  ];

  const assistantMessage = `No mês de ${targetMonth} você teve ${summary.expensesCount} lançamentos, totalizando ${formatCurrency(summary.totalExpensesCents)}. O saldo em conta está em ${formatCurrency(summary.balanceCents)}.`;

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

    const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
    const userName = dbUser?.name || "";
    const isNewUser = !userName;

    if (message === "[SYSTEM_INIT]") {
      const horaAtual = dayjs().tz(TZ).hour();
      let saudacaoTempo = "Bom dia";
      if (horaAtual >= 12 && horaAtual < 18) saudacaoTempo = "Boa tarde";
      else if (horaAtual >= 18) saudacaoTempo = "Boa noite";

      if (userName) return res.status(200).json({ conversationId, assistantMessage: `${saudacaoTempo}, ${userName}! Como posso ajudar você a organizar suas finanças hoje?` });
      else return res.status(200).json({ conversationId, assistantMessage: `Olá! Seja muito bem-vindo ao Financio. Eu sou seu assistente financeiro. Como você gostaria que eu te chamasse?` });
    }

    const prompt = `
      Você é o "Super Assistente", um consultor financeiro inteligente do app "Financio". 
      Mês atual: ${currentMonth}.
      Categorias cadastradas: [${categoryNames || "Nenhuma ainda"}].
      Mensagem do usuário: "${message}"

      COMPORTAMENTO E PERSONALIDADE:
      ${isNewUser ? 
        `- O NOME DO USUÁRIO ESTÁ VAZIO. Se a mensagem for um nome, classifique OBRIGATORIAMENTE como "set_name". Responda confirmando que gravou o nome e seja simpático (ex: "Muito prazer, [Nome]!"). NUNCA escreva "Novo Usuário".` : 
        `- O usuário se chama ${userName}. Chame-o pelo nome de forma natural.`
      }

      Regras de Intenção (intent):
      1. "chat": Saudação ou conversa.
      2. "expense": Registrar gasto numérico.
      3. "dashboard": Resumos ou relatórios.
      4. "delete_last": Apagar último lançamento.
      5. "compare": Comparar meses.
      6. "set_budget": Definir limite/meta de gastos de uma categoria.
      7. "set_salary": Definir salário mensal do usuário.
      8. "add_extra": Adicionar um ganho extra / freela / bônus.
      9. "set_savings": Definir o valor que foi guardado na poupança / reserva.
      10. "set_name": Salvar o nome inicial do usuário.

      Formato de Saída OBRIGATÓRIO:
      {
        "intent": "chat" | "expense" | "dashboard" | "delete_last" | "compare" | "set_budget" | "set_salary" | "add_extra" | "set_savings" | "set_name",
        "extractedName": "Nome capitalizado extraído. Vazio se não for set_name",
        "targetMonth": "${currentMonth}", 
        "reply": "Sua resposta humanizada",
        "expenseDetails": { "description": "Nome do item ou categoria", "amount": 0, "method": "PIX", "category": "Categoria" }
      }
    `;

    const result = await aiModel.generateContent(prompt);
    let textoResposta = result.response.text().trim().replace(/```json/g, "").replace(/```/g, "").trim();
    const aiDecision = JSON.parse(textoResposta);

    // --- 0. SALVAR NOME ---
    if (aiDecision.intent === "set_name" && aiDecision.extractedName) {
      await prisma.user.update({ where: { id: user.id }, data: { name: aiDecision.extractedName } });
      return res.status(200).json({ conversationId, assistantMessage: aiDecision.reply || `Muito prazer, ${aiDecision.extractedName}! Já gravei seu nome aqui.`, refreshData: true });
    }

    // --- 1. SALÁRIO, RESERVAS E EXTRAS ---
    if (["set_salary", "set_savings", "add_extra"].includes(aiDecision.intent)) {
      try {
        const rawAmount = aiDecision.expenseDetails?.amount;
        const amountCents = Math.round(Math.abs(Number(rawAmount)) * 100);

        if (isNaN(amountCents) || amountCents <= 0) {
          return res.status(200).json({ conversationId, assistantMessage: "Não consegui identificar o valor exato. Pode mandar de novo com o número claro?" });
        }

        let planning = await prisma.planning.findFirst({ where: { userId: user.id } });
        if (!planning) planning = await prisma.planning.create({ data: { userId: user.id, data: { salaryByMonth: {}, extrasByMonth: {}, savingsByMonth: {}, categoryBudgets: {} } } });

        const currentData = (planning.data as any) || {};

        if (aiDecision.intent === "set_salary") {
          currentData.salaryByMonth = { ...(currentData.salaryByMonth || {}), [currentMonth]: amountCents };
        } else if (aiDecision.intent === "set_savings") {
          currentData.savingsByMonth = { ...(currentData.savingsByMonth || {}), [currentMonth]: amountCents };
        } else if (aiDecision.intent === "add_extra") {
          if (!currentData.extrasByMonth) currentData.extrasByMonth = {};
          if (!currentData.extrasByMonth[currentMonth]) currentData.extrasByMonth[currentMonth] = [];
          currentData.extrasByMonth[currentMonth].push({ id: `id-${Date.now()}`, date: new Date().toISOString().split("T")[0], description: aiDecision.expenseDetails.description || "Ganho Extra", amount: amountCents });
        }

        await prisma.planning.update({ where: { id: planning.id }, data: { data: currentData } });

        return res.status(200).json({ conversationId, assistantMessage: `✅ Tudo certo, ${userName}! Já registrei o valor de **${formatCurrency(amountCents)}** no seu planejamento. 💸`, refreshData: true });
      } catch (err) {
        return res.status(200).json({ conversationId, assistantMessage: "Ops, não consegui salvar no planejamento. Pode tentar de novo?" });
      }
    }

    // --- 2. DEFINIR META (SET_BUDGET) PADRONIZADO MINÚSCULO ---
    if (aiDecision.intent === "set_budget") {
      try {
        const rawAmount = aiDecision.expenseDetails?.amount;
        const amountCents = Math.round(Math.abs(Number(rawAmount)) * 100);
        const categoryName = aiDecision.expenseDetails?.category;

        if (isNaN(amountCents) || amountCents <= 0 || !categoryName) {
          return res.status(200).json({ conversationId, assistantMessage: "Não consegui pegar o valor ou a categoria da meta. Pode mandar novamente?" });
        }

        // CHAVE MESTRA: Salva e pesquisa a categoria SEMPRE minúscula e sem espaços extras
        const safeCategoryKey = categoryName.toLowerCase().trim();

        let category = await prisma.category.findFirst({ where: { userId: user.id, normalizedName: safeCategoryKey } });
        if (!category) category = await prisma.category.create({ data: { userId: user.id, name: categoryName, normalizedName: safeCategoryKey } });

        let planning = await prisma.planning.findFirst({ where: { userId: user.id } });
        if (!planning) planning = await prisma.planning.create({ data: { userId: user.id, data: { categoryBudgets: {} } } });

        const currentData = (planning.data as any) || {};
        if (!currentData.categoryBudgets) currentData.categoryBudgets = {};
        
        // SALVA COM A CHAVE SEGURA
        currentData.categoryBudgets[safeCategoryKey] = amountCents;

        await prisma.planning.update({ where: { id: planning.id }, data: { data: currentData } });

        return res.status(200).json({ conversationId, assistantMessage: `✅ Meta para **${category.name}** definida em **${formatCurrency(amountCents)}**.`, refreshData: true });
      } catch (err) {
        return res.status(200).json({ conversationId, assistantMessage: "Problema técnico ao salvar a meta. Pode tentar de novo?" });
      }
    }

    // --- 3. REGISTRAR DESPESA ---
    if (aiDecision.intent === "expense") {
      try {
        const rawAmount = aiDecision.expenseDetails?.amount;
        const amountCents = Math.round(Math.abs(Number(rawAmount)) * 100);
        const categoryName = aiDecision.expenseDetails?.category || "Outros";
        
        // Usa a chave segura para buscar e alertar a meta
        const safeCategoryKey = categoryName.toLowerCase().trim();
        
        let category = await prisma.category.findFirst({ where: { userId: user.id, normalizedName: safeCategoryKey } });
        if (!category) category = await prisma.category.create({ data: { userId: user.id, name: categoryName, normalizedName: safeCategoryKey } });

        await prisma.expense.create({
          data: { userId: user.id, categoryId: category.id, amountCents, paymentMethod: aiDecision.expenseDetails.method, description: aiDecision.expenseDetails.description, date: new Date(), source: 'AI_CHAT', rawText: message }
        });

        const summary = await tool_getDashboardSummary(user.id, currentMonth);
        const planning = await prisma.planning.findFirst({ where: { userId: user.id } });
        
        const currentData = (planning?.data as any) || {};
        const budgets = currentData.categoryBudgets || {};
        
        // Busca a meta usando a chave segura
        const budgetCents = budgets[safeCategoryKey] || 0;
        
        const catSummary = summary.totalPorCategoria.find(c => c.category.toLowerCase().trim() === safeCategoryKey);
        const totalGastoAtual = catSummary ? catSummary.total : 0;

        let alertaBudget = "";
        if (budgetCents > 0) {
          const percentual = (totalGastoAtual / budgetCents) * 100;
          if (percentual >= 100) alertaBudget = `\n\n🚨 **ESTOUROU!** Você já passou da meta de ${categoryName}!`;
          else if (percentual >= 80) alertaBudget = `\n\n⚠️ **ATENÇÃO:** Você atingiu ${percentual.toFixed(0)}% da meta de ${categoryName}. Resta ${formatCurrency(budgetCents - totalGastoAtual)}!`;
        }

        return res.status(200).json({ conversationId, assistantMessage: `${aiDecision.reply}${alertaBudget}\n\n✅ Salvo!\n🛒 **${aiDecision.expenseDetails.description}**\n💰 ${formatCurrency(amountCents)}\n📂 ${categoryName}`, refreshData: true });
      } catch (dbError) {
        return res.status(200).json({ conversationId, assistantMessage: "Ops, dei um tropeço aqui ao salvar esse lançamento. Pode mandar de novo? 🙏" });
      }
    }

    // --- 4. APAGAR ÚLTIMO ---
    if (aiDecision.intent === "delete_last") {
      try {
        const lastExpense = await prisma.expense.findFirst({ where: { userId: user.id }, orderBy: { id: 'desc' } });
        if (!lastExpense) return res.status(200).json({ conversationId, assistantMessage: "Nenhum lançamento recente encontrado." });
        
        await prisma.expense.delete({ where: { id: lastExpense.id } });
        return res.status(200).json({ conversationId, assistantMessage: `🗑️ Apaguei: **${lastExpense.description}**.`, refreshData: true });
      } catch (err) {
        return res.status(200).json({ conversationId, assistantMessage: "Putz, não consegui apagar a última despesa. Pode tentar de novo? 😅" });
      }
    }

    // --- 5. COMPARAÇÃO E DASHBOARD ---
    if (aiDecision.intent === "compare") {
      // ... (Restante do código de comparação mantido igual)
      try {
        const month1 = aiDecision.targetMonth || currentMonth;
        const month2 = aiDecision.compareMonth || lastMonth;
        const summary1 = await tool_getDashboardSummary(user.id, month1);
        const summary2 = await tool_getDashboardSummary(user.id, month2);
        const diffCents = summary1.totalExpensesCents - summary2.totalExpensesCents;
        const economizou = diffCents <= 0;

        const cards = [{
          type: "metric", title: `Comparativo: ${month1} vs ${month2}`,
          data: { value: economizou ? Math.abs(diffCents) : -Math.abs(diffCents), currency: "BRL", detail: `${month1}: ${formatCurrency(summary1.totalExpensesCents)}\n${month2}: ${formatCurrency(summary2.totalExpensesCents)}` }
        }];

        let resposta = aiDecision.reply || (economizou ? `Gastou **${formatCurrency(Math.abs(diffCents))} a menos**.` : `Gastou **${formatCurrency(Math.abs(diffCents))} a mais**.`);
        return res.status(200).json({ conversationId, assistantMessage: resposta, cards, suggestedActions: [] });
      } catch (err) {
        return res.status(200).json({ conversationId, assistantMessage: "Não conseguir comparar, pode me mandar novamente de forma mais clara? 😅." });
      }
    }

    if (aiDecision.intent === "dashboard") {
      const payload = await buildAssistantResponse(user.id, aiDecision.targetMonth, message);
      return res.status(200).json({ conversationId, assistantMessage: aiDecision.reply || payload.assistantMessage, cards: payload.cards, suggestedActions: payload.suggestedActions });
    }

    // --- 6. CHAT GENÉRICO ---
    return res.status(200).json({ conversationId, assistantMessage: aiDecision.reply, cards: [], suggestedActions: [{ label: "Ver resumos" }] });

  } catch (err) {
    return res.status(200).json({ conversationId, assistantMessage: "Tive um problema de processamento." });
  }
});

export default router;