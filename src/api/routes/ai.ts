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

function extractMoneyCents(aiAmount: any, userText: string): number {
  let val = Number(aiAmount);
  if (isNaN(val) || val <= 0) {
    const matches = userText.match(/\d+(?:[.,]\d+)*/g);
    if (matches && matches.length > 0) {
      let strVal = matches[0];
      if (strVal.includes(',')) strVal = strVal.replace(/\./g, '').replace(',', '.');
      else if (strVal.split('.').length > 2) strVal = strVal.replace(/\./g, '');
      val = Number(strVal);
    }
  }
  return (!isNaN(val) && val > 0) ? Math.round(val * 100) : 0;
}

async function buildAssistantResponse(userId: number, targetMonth: string, message: string) {
  const toolsUsed = new Set<string>();
  const summary = await tool_getDashboardSummary(userId, targetMonth);
  const topEntries = await tool_getTopEntries(userId, targetMonth, 5);

  const cards: Array<Record<string, any>> = [];
  cards.push({
    type: "metric", title: `Saldo estimado (${targetMonth})`,
    data: { value: summary.balanceCents, currency: "BRL", detail: `Receitas: ${formatCurrency(summary.receitasCents)} • Gastos: ${formatCurrency(summary.totalExpensesCents)}` },
  });

  if (summary.totalPorCategoria.length) {
    cards.push({ type: "chart", title: "Gastos por Categoria", data: summary.totalPorCategoria.slice(0, 4).map(item => ({ name: item.category, value: item.total })) });
  }

  const suggestedActions = [{ id: "ai-compare-month", label: "Comparar com mês passado", payload: { kind: "compareMonth" } }];
  const assistantMessage = `Neste mês você teve ${summary.expensesCount} lançamentos (${formatCurrency(summary.totalExpensesCents)}). O saldo em conta está em ${formatCurrency(summary.balanceCents)}.`;

  return { assistantMessage, cards, suggestedActions };
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

      if (userName) return res.status(200).json({ conversationId, assistantMessage: `${saudacaoTempo}, ${userName}! Como posso ajudar você hoje?` });
      else return res.status(200).json({ conversationId, assistantMessage: `Olá! Seja muito bem-vindo. Como você gostaria que eu te chamasse?` });
    }

    const prompt = `
      Você é o "Super Assistente" do app "Financio". Mês atual: ${currentMonth}.
      Categorias cadastradas: [${categoryNames || "Nenhuma ainda"}].
      Mensagem do usuário: "${message}"

      Regras de Intenção (intent):
      1. "chat": Conversa geral.
      2. "expense": Registrar gasto numérico (Aceita parcelas e nome de cartão).
      3. "dashboard": Resumos ou saldos.
      4. "delete_last": Apagar último lançamento.
      5. "compare": Comparar meses.
      6. "set_budget": Definir meta.
      7. "set_salary": Definir salário.
      8. "add_extra": Adicionar freela.
      9. "set_savings": Definir valor na reserva.
      10. "set_name": Salvar o nome inicial.

      Formato OBRIGATÓRIO (Apenas JSON):
      {
        "intent": "chat" | "expense" | "dashboard" | "delete_last" | "compare" | "set_budget" | "set_salary" | "add_extra" | "set_savings" | "set_name",
        "extractedName": "Nome se for set_name",
        "targetMonth": "${currentMonth}", 
        "reply": "Sua resposta",
        "expenseDetails": { 
          "description": "Nome curto", 
          "amount": 0,
          "method": "CREDIT", 
          "category": "Categoria",
          "installments": 1,
          "cardName": "Nome do cartão se houver (ex: Inter, Nubank). Vazio se não tiver."
        }
      }
    `;

    const result = await aiModel.generateContent(prompt);
    let textoResposta = result.response.text().trim().replace(/```json/g, "").replace(/```/g, "").trim();
    
    let aiDecision;
    try {
      const jsonMatch = textoResposta.match(/\{[\s\S]*\}/);
      aiDecision = JSON.parse(jsonMatch ? jsonMatch[0] : textoResposta);
    } catch (parseErr) {
      return res.status(200).json({ conversationId, assistantMessage: "Desculpe, meu cérebro deu um nó! Pode mandar de novo?" });
    }

    if (aiDecision.intent === "set_name" && aiDecision.extractedName) {
      await prisma.user.update({ where: { id: user.id }, data: { name: aiDecision.extractedName } });
      return res.status(200).json({ conversationId, assistantMessage: aiDecision.reply || `Muito prazer, ${aiDecision.extractedName}!`, refreshData: true });
    }

    if (["set_salary", "set_savings", "add_extra"].includes(aiDecision.intent)) {
      try {
        const amountCents = extractMoneyCents(aiDecision.expenseDetails?.amount, message);
        if (amountCents === 0) return res.status(200).json({ conversationId, assistantMessage: "Não consegui identificar o valor exato." });

        let planning = await prisma.planning.findFirst({ where: { userId: user.id } });
        if (!planning) planning = await prisma.planning.create({ data: { userId: user.id, data: { salaryByMonth: {}, extrasByMonth: {}, savingsByMonth: {}, categoryBudgets: {} } } });

        const currentData = JSON.parse(JSON.stringify(planning.data || {}));
        if (!currentData.salaryByMonth) currentData.salaryByMonth = {};
        if (!currentData.savingsByMonth) currentData.savingsByMonth = {};
        if (!currentData.extrasByMonth) currentData.extrasByMonth = {};

        if (aiDecision.intent === "set_salary") currentData.salaryByMonth[currentMonth] = amountCents;
        else if (aiDecision.intent === "set_savings") currentData.savingsByMonth[currentMonth] = amountCents;
        else if (aiDecision.intent === "add_extra") {
          if (!currentData.extrasByMonth[currentMonth]) currentData.extrasByMonth[currentMonth] = [];
          currentData.extrasByMonth[currentMonth].push({ id: `id-${Date.now()}`, date: new Date().toISOString().split("T")[0], description: aiDecision.expenseDetails?.description || "Ganho Extra", amount: amountCents });
        }

        await prisma.planning.update({ where: { id: planning.id }, data: { data: currentData } });
        return res.status(200).json({ conversationId, assistantMessage: `✅ Valor registrado no planejamento!`, refreshData: true });
      } catch (err) { return res.status(200).json({ conversationId, assistantMessage: "Ops, erro ao salvar no planejamento." }); }
    }

    if (aiDecision.intent === "set_budget") {
      try {
        const amountCents = extractMoneyCents(aiDecision.expenseDetails?.amount, message);
        const categoryName = aiDecision.expenseDetails?.category;
        if (amountCents === 0 || !categoryName) return res.status(200).json({ conversationId, assistantMessage: "Não consegui pegar o valor ou a categoria da meta." });

        const safeCategoryKey = categoryName.toLowerCase().trim();
        let category = await prisma.category.findFirst({ where: { userId: user.id, normalizedName: safeCategoryKey } });
        if (!category) category = await prisma.category.create({ data: { userId: user.id, name: categoryName, normalizedName: safeCategoryKey } });

        let planning = await prisma.planning.findFirst({ where: { userId: user.id } });
        if (!planning) planning = await prisma.planning.create({ data: { userId: user.id, data: { categoryBudgets: {} } } });

        const currentData = JSON.parse(JSON.stringify(planning.data || {}));
        if (!currentData.categoryBudgets) currentData.categoryBudgets = {};
        currentData.categoryBudgets[safeCategoryKey] = amountCents;

        await prisma.planning.update({ where: { id: planning.id }, data: { data: currentData } });
        return res.status(200).json({ conversationId, assistantMessage: `✅ Meta para **${category.name}** definida em **${formatCurrency(amountCents)}**.`, refreshData: true });
      } catch (err) { return res.status(200).json({ conversationId, assistantMessage: "Problema técnico ao salvar a meta." }); }
    }

    // --- 3. REGISTRAR DESPESA (MOTOR DE CARTÕES COM VÍNCULO CORRETO) ---
    if (aiDecision.intent === "expense") {
      try {
        const amountCents = extractMoneyCents(aiDecision.expenseDetails?.amount, message);
        if (amountCents === 0) return res.status(200).json({ conversationId, assistantMessage: "Não achei o valor da despesa." });

        const categoryName = aiDecision.expenseDetails?.category || "Outros";
        const safeCategoryKey = categoryName.toLowerCase().trim();
        let category = await prisma.category.findFirst({ where: { userId: user.id, normalizedName: safeCategoryKey } });
        if (!category) category = await prisma.category.create({ data: { userId: user.id, name: categoryName, normalizedName: safeCategoryKey } });

        let method = (aiDecision.expenseDetails?.method || "OTHER").toUpperCase();
        const msgLower = message.toLowerCase();
        
        if (msgLower.includes("cartão") || msgLower.includes("crédito") || msgLower.includes("credit") || msgLower.includes("x ") || msgLower.match(/\dx/)) method = "CREDIT";
        else if (msgLower.includes("débito") || msgLower.includes("debit")) method = "DEBIT";
        else if (msgLower.includes("pix")) method = "PIX";

        // CAÇADOR DE CARTÕES FORÇA-BRUTA
        let cardId = null;
        let cardFoundName = "";
        
        if (method === "CREDIT") {
            const userCards = await prisma.card.findMany({ where: { userId: user.id } });
            const cName = (aiDecision.expenseDetails?.cardName || "").toLowerCase().trim();

            // Tenta achar pelo nome direto na frase ou no que a IA entendeu
            const matchedCard = userCards.find(c => {
                const dbName = c.name.toLowerCase().trim();
                return (cName && dbName.includes(cName)) || msgLower.includes(dbName);
            });

            if (matchedCard) {
                cardId = matchedCard.id;
                cardFoundName = matchedCard.name;
            } 
            // Se o usuário tem SÓ UM cartão de crédito cadastrado, usa ele por padrão
            else if (userCards.length === 1) {
                cardId = userCards[0].id;
                cardFoundName = userCards[0].name;
            }
        }

        let installments = aiDecision.expenseDetails?.installments || 1;
        // Resgate caso a IA não retorne a parcela corretamente mas exista "5x" na frase
        const matchInstallment = msgLower.match(/(\d+)\s*x/);
        if (matchInstallment && installments === 1) installments = parseInt(matchInstallment[1], 10);

        const isInstallment = installments > 1;
        const installmentAmountCents = isInstallment ? Math.round(amountCents / installments) : amountCents;
        const baseDescription = aiDecision.expenseDetails?.description || "Gasto";

        // Cria a data da transação hoje, garantindo o horário do meio dia para evitar falhas de fuso horário
        let baseDate = dayjs().tz(TZ).hour(12).minute(0).second(0);
        
        const expensesToCreate = [];
        for (let i = 1; i <= installments; i++) {
            // Apenas lança os meses futuros perfeitamente!
            const expDate = baseDate.add(i - 1, 'month').toDate();
            expensesToCreate.push({
                userId: user.id,
                categoryId: category.id,
                amountCents: installmentAmountCents,
                paymentMethod: method as any,
                description: isInstallment ? `${baseDescription} (${i}/${installments})` : baseDescription,
                date: expDate, 
                source: 'AI_CHAT',
                rawText: message,
                cardId: cardId, // AGORA A DESPESA NÃO FICA ÓRFÃ!
                installmentCurrent: isInstallment ? i : null,
                installmentTotal: isInstallment ? installments : null
            });
        }

        await Promise.all(expensesToCreate.map(data => prisma.expense.create({ data })));

        const cardMsg = cardFoundName ? `no cartão **${cardFoundName}**` : `no **Crédito**`;
        const installmentMsg = isInstallment ? `dividido em **${installments}x de ${formatCurrency(installmentAmountCents)}**` : ``;
        
        return res.status(200).json({ 
            conversationId, 
            assistantMessage: `✅ Salvo com sucesso!\n🛒 **${baseDescription}**\n💰 Total: ${formatCurrency(amountCents)}\n💳 Pagamento: ${method === 'CREDIT' ? cardMsg : method} ${installmentMsg}`, 
            refreshData: true 
        });
      } catch (dbError) {
        return res.status(200).json({ conversationId, assistantMessage: "Ops, erro ao salvar esse gasto. Tente novamente." });
      }
    }

    if (aiDecision.intent === "delete_last") {
      try {
        const lastExpense = await prisma.expense.findFirst({ where: { userId: user.id }, orderBy: { id: 'desc' } });
        if (!lastExpense) return res.status(200).json({ conversationId, assistantMessage: "Nenhum lançamento recente encontrado." });
        await prisma.expense.delete({ where: { id: lastExpense.id } });
        return res.status(200).json({ conversationId, assistantMessage: `🗑️ Apaguei: **${lastExpense.description}**.`, refreshData: true });
      } catch (err) { return res.status(200).json({ conversationId, assistantMessage: "Problema ao apagar." }); }
    }

    if (aiDecision.intent === "compare") {
      try {
        const month1 = aiDecision.targetMonth || currentMonth;
        const month2 = aiDecision.compareMonth || lastMonth;
        const summary1 = await tool_getDashboardSummary(user.id, month1);
        const summary2 = await tool_getDashboardSummary(user.id, month2);
        const diffCents = summary1.totalExpensesCents - summary2.totalExpensesCents;
        const economizou = diffCents <= 0;

        const cards = [{
          type: "metric", title: `Comparativo: ${month1} vs ${month2}`,
          data: { value: Math.abs(diffCents), currency: "BRL", detail: `${month1}: ${formatCurrency(summary1.totalExpensesCents)}\n${month2}: ${formatCurrency(summary2.totalExpensesCents)}` }
        }];

        let resposta = aiDecision.reply || (economizou ? `Gastou **${formatCurrency(Math.abs(diffCents))} a menos**.` : `Gastou **${formatCurrency(Math.abs(diffCents))} a mais**.`);
        return res.status(200).json({ conversationId, assistantMessage: resposta, cards, suggestedActions: [] });
      } catch (err) { return res.status(200).json({ conversationId, assistantMessage: "Não consegui comparar. Tente novamente de forma mais clara." }); }
    }

    if (aiDecision.intent === "dashboard") {
      const payload = await buildAssistantResponse(user.id, aiDecision.targetMonth, message);
      return res.status(200).json({ conversationId, assistantMessage: aiDecision.reply || payload.assistantMessage, cards: payload.cards, suggestedActions: payload.suggestedActions });
    }

    return res.status(200).json({ conversationId, assistantMessage: aiDecision.reply, cards: [], suggestedActions: [{ label: "Ver resumos" }] });

  } catch (err) {
    console.error("Erro Fatal IA:", err);
    return res.status(200).json({ conversationId, assistantMessage: "Tive um problema de processamento grave, mas já estamos de olho." });
  }
});

export default router;