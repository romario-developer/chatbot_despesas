import { Router } from "express";

import { prisma } from "../../db/prisma";
import { runBackup } from "../../services/backupService";
import { getOrCreateUser, getAdminUser } from "../../services/userService";
import { normalizeCategoryName } from "../../utils/normalize";
import { API_TELEGRAM_ID } from "../../utils/systemUsers";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  console.warn("[admin] ADMIN_TOKEN n’o definido; /api/admin/backup ficarÿ inativo.");
}

const router = Router();

router.get("/backup", async (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: "ADMIN_TOKEN n’o configurado" });
  }

  const auth = req.headers.authorization;
  const token = auth?.replace(/^Bearer /i, "").trim();
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { filePath, payload } = await runBackup();
    console.log("[admin][backup] gerado em", filePath, "contagens:", payload.meta.counts);

    res.setHeader("Content-Disposition", `attachment; filename=${filePath.split("/").pop()}`);
    return res.json(payload);
  } catch (err) {
    console.error("[admin][backup] falhou:", err);
    return res.status(500).json({ error: "Falha ao gerar backup" });
  }
});

router.get("/debug/user-data-summary", async (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: "ADMIN_TOKEN n’o configurado" });
  }
  const auth = req.headers.authorization;
  const token = auth?.replace(/^Bearer /i, "").trim();
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const [expensesTotal, expensesByUserId, planning] = await Promise.all([
      prisma.expense.count(),
      prisma.expense.groupBy({
        by: ["userId"],
        _count: true,
        _sum: { amountCents: true },
      }),
      prisma.planning.findMany({ select: { userId: true, data: true } }),
    ]);

    const planningByUserId = planning.map((p) => {
      const salaryByMonth = (p.data as any)?.salaryByMonth ?? {};
      const salaryTotal = Object.values(salaryByMonth).reduce((sum: number, val: any) => {
        const num = typeof val === "number" ? val : Number(val);
        return Number.isFinite(num) ? sum + num : sum;
      }, 0);
      return { userId: p.userId, salaryTotal };
    });

    return res.json({
      expensesTotal,
      expensesByUserId: expensesByUserId.map((row) => ({
        userId: row.userId,
        count: row._count,
        amountCents: row._sum.amountCents ?? 0,
      })),
      planningByUserId,
    });
  } catch (err) {
    console.error("[admin][debug/user-data-summary] erro:", err);
    return res.status(500).json({ error: "Falha ao coletar dados" });
  }
});
type MigrateResult = {
  movedEntries: number;
  movedDrafts: number;
  movedCategories: number;
  movedPlanning: number;
  movedSessions: number;
  oldUserId: number | null;
  newUserId: number | null;
};

type MigrateByIdResult = MigrateResult;

type LinkInfo = {
  id: number;
  chatId: string | null;
  telegramUserId: string;
  userId: number;
  userTelegramId: string;
  createdAt: Date;
  updatedAt?: Date | null;
  lastMessageAt?: Date | null;
};

async function resolveUserByTelegramId(telegramId: string) {
  return prisma.user.findFirst({
    where: { OR: [{ telegramId }, { telegramChatId: telegramId }] },
  });
}

async function migrateUserDataToTarget(oldUserId: number, newUserId: number) {
  if (oldUserId === newUserId) {
    return {
      movedEntries: 0,
      movedDrafts: 0,
      movedCategories: 0,
      movedPlanning: 0,
      movedSessions: 0,
      oldUserId,
      newUserId,
    };
  }

  const oldCategories = await prisma.category.findMany({ where: { userId: oldUserId } });
  let movedCategories = 0;
  const categoryMap = new Map<number, number>();

  for (const cat of oldCategories) {
    const normalizedName = cat.normalizedName || normalizeCategoryName(cat.name);
    const existing = await prisma.category.findFirst({
      where: { userId: newUserId, normalizedName },
    });

    let targetId = existing?.id;
    if (!targetId) {
      const created = await prisma.category.create({
        data: {
          userId: newUserId,
          name: cat.name,
          normalizedName,
        },
      });
      targetId = created.id;
      movedCategories += 1;
    }

    categoryMap.set(cat.id, targetId);
  }

  let movedEntries = 0;
  for (const [oldCatId, newCatId] of categoryMap.entries()) {
    const updated = await prisma.expense.updateMany({
      where: { userId: oldUserId, categoryId: oldCatId },
      data: { userId: newUserId, categoryId: newCatId },
    });
    movedEntries += updated.count;
  }

  let movedDrafts = 0;
  for (const [oldCatId, newCatId] of categoryMap.entries()) {
    const updated = await prisma.expenseDraft.updateMany({
      where: { userId: oldUserId, categoryId: oldCatId },
      data: { userId: newUserId, categoryId: newCatId },
    });
    movedDrafts += updated.count;
  }

  let movedPlanning = 0;
  const oldPlanning = await prisma.planning.findUnique({ where: { userId: oldUserId } });
  const newPlanning = await prisma.planning.findUnique({ where: { userId: newUserId } });
  if (oldPlanning) {
    if (newPlanning) {
      const oldData = typeof oldPlanning.data === "object" && oldPlanning.data ? (oldPlanning.data as any) : {};
      const newData = typeof newPlanning.data === "object" && newPlanning.data ? (newPlanning.data as any) : {};
      // merge basic fields favoring target, but keep old data as fallback
      await prisma.planning.update({
        where: { id: newPlanning.id },
        data: {
          data: { ...oldData, ...newData },
        },
      });
      movedPlanning = 1;
      await prisma.planning.delete({ where: { userId: oldUserId } }).catch(() => {});
    } else {
      await prisma.planning.update({
        where: { userId: oldUserId },
        data: { userId: newUserId },
      });
      movedPlanning = 1;
    }
  }

  let movedSessions = 0;
  const oldSession = await prisma.userSession.findUnique({ where: { userId: oldUserId } });
  if (oldSession) {
    await prisma.userSession.upsert({
      where: { userId: newUserId },
      create: {
        userId: newUserId,
        mode: oldSession.mode,
        draftId: oldSession.draftId,
        resetToken: oldSession.resetToken,
        resetTokenExpiresAt: oldSession.resetTokenExpiresAt,
      },
      update: {
        mode: oldSession.mode,
        draftId: oldSession.draftId,
        resetToken: oldSession.resetToken,
        resetTokenExpiresAt: oldSession.resetTokenExpiresAt,
      },
    });
    await prisma.userSession.delete({ where: { userId: oldUserId } }).catch(() => {});
    movedSessions = 1;
  }

  await prisma.telegramLinkCode.updateMany({
    where: { userId: oldUserId },
    data: { userId: newUserId },
  });

  return {
    movedEntries,
    movedDrafts,
    movedCategories,
    movedPlanning,
    movedSessions,
    oldUserId,
    newUserId,
  };
}

async function migrateUserData(oldTelegramId: string, newTelegramId: string): Promise<MigrateResult> {
  const oldUser = await resolveUserByTelegramId(oldTelegramId);
  if (!oldUser) {
    throw new Error(`Usuario antigo nao encontrado para telegramId="${oldTelegramId}"`);
  }

  const newUser = await getOrCreateUser(newTelegramId || API_TELEGRAM_ID);

  if (oldUser.id === newUser.id) {
    return {
      movedEntries: 0,
      movedDrafts: 0,
      movedCategories: 0,
      movedPlanning: 0,
      movedSessions: 0,
      oldUserId: oldUser.id,
      newUserId: newUser.id,
    };
  }

  // Map categories (idempotente)
  const oldCategories = await prisma.category.findMany({ where: { userId: oldUser.id } });
  let movedCategories = 0;
  const categoryMap = new Map<number, number>();

  for (const cat of oldCategories) {
    const normalizedName = cat.normalizedName || normalizeCategoryName(cat.name);
    const existing = await prisma.category.findFirst({
      where: { userId: newUser.id, normalizedName },
    });

    let targetId = existing?.id;
    if (!targetId) {
      const created = await prisma.category.create({
        data: {
          userId: newUser.id,
          name: cat.name,
          normalizedName,
        },
      });
      targetId = created.id;
      movedCategories += 1;
    }

    categoryMap.set(cat.id, targetId);
  }

  let movedEntries = 0;
  for (const [oldCatId, newCatId] of categoryMap.entries()) {
    const updated = await prisma.expense.updateMany({
      where: { userId: oldUser.id, categoryId: oldCatId },
      data: { userId: newUser.id, categoryId: newCatId },
    });
    movedEntries += updated.count;
  }

  let movedDrafts = 0;
  for (const [oldCatId, newCatId] of categoryMap.entries()) {
    const updated = await prisma.expenseDraft.updateMany({
      where: { userId: oldUser.id, categoryId: oldCatId },
      data: { userId: newUser.id, categoryId: newCatId },
    });
    movedDrafts += updated.count;
  }

  let movedPlanning = 0;
  const oldPlanning = await prisma.planning.findUnique({ where: { userId: oldUser.id } });
  const newPlanning = await prisma.planning.findUnique({ where: { userId: newUser.id } });
  if (oldPlanning && !newPlanning) {
    await prisma.planning.update({
      where: { userId: oldUser.id },
      data: { userId: newUser.id },
    });
    movedPlanning = 1;
  }

  let movedSessions = 0;
  const oldSession = await prisma.userSession.findUnique({ where: { userId: oldUser.id } });
  if (oldSession) {
    await prisma.userSession.upsert({
      where: { userId: newUser.id },
      create: {
        userId: newUser.id,
        mode: oldSession.mode,
        draftId: oldSession.draftId,
        resetToken: oldSession.resetToken,
        resetTokenExpiresAt: oldSession.resetTokenExpiresAt,
      },
      update: {
        mode: oldSession.mode,
        draftId: oldSession.draftId,
        resetToken: oldSession.resetToken,
        resetTokenExpiresAt: oldSession.resetTokenExpiresAt,
      },
    });
    await prisma.userSession.delete({ where: { userId: oldUser.id } });
    movedSessions = 1;
  }

  await prisma.telegramLinkCode.updateMany({
    where: { userId: oldUser.id },
    data: { userId: newUser.id },
  });

  return {
    movedEntries,
    movedDrafts,
    movedCategories,
    movedPlanning,
    movedSessions,
    oldUserId: oldUser.id,
    newUserId: newUser.id,
  };
}

// TEMPORARIO: remover apos migracao concluida
router.post("/migrate-user-data", async (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ error: "ADMIN_TOKEN nao configurado" });
  }

  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { oldTelegramId, newTelegramId } = req.body ?? {};
  if (typeof oldTelegramId !== "string" || !oldTelegramId.trim()) {
    return res.status(400).json({ error: '"oldTelegramId" obrigatorio' });
  }
  if (typeof newTelegramId !== "string" || !newTelegramId.trim()) {
    return res.status(400).json({ error: '"newTelegramId" obrigatorio' });
  }

  try {
    const result = await migrateUserData(oldTelegramId.trim(), newTelegramId.trim());
    return res.json(result);
  } catch (err) {
    console.error("[admin][migrate-user-data] erro:", err);
    const message = err instanceof Error ? err.message : "Falha na migracao";
    return res.status(500).json({ error: message });
  }
});

// Lista usuarios com contagens para identificar quem possui despesas
router.get("/users/with-counts", async (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ error: "ADMIN_TOKEN nao configurado" });
  }
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const users = await prisma.user.findMany({
      select: { id: true, telegramId: true, createdAt: true },
    });

    const withCounts = await Promise.all(
      users.map(async (u) => {
        const [entriesCount, planningCount] = await Promise.all([
          prisma.expense.count({ where: { userId: u.id } }),
          prisma.planning.count({ where: { userId: u.id } }),
        ]);
        return {
          id: u.id,
          telegramId: u.telegramId,
          createdAt: u.createdAt,
          entriesCount,
          planningCount,
        };
      }),
    );

    withCounts.sort((a, b) => b.entriesCount - a.entriesCount);
    return res.json(withCounts);
  } catch (err) {
    console.error("[admin][users/with-counts] erro:", err);
    return res.status(500).json({ error: "Falha ao listar usuarios" });
  }
});

// Listar links do Telegram para diagnostico de chatId vinculado
router.get("/telegram/links", async (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ error: "ADMIN_TOKEN nao configurado" });
  }
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const links = await prisma.user.findMany({
      select: {
        id: true,
        telegramId: true,
        telegramChatId: true,
        createdAt: true,
      },
      where: { telegramChatId: { not: null } },
      orderBy: { createdAt: "desc" },
    });

    const mapped: LinkInfo[] = links.map((u) => ({
      id: u.id,
      chatId: u.telegramChatId ?? null,
      telegramUserId: u.telegramId,
      userId: u.id,
      userTelegramId: u.telegramId,
      createdAt: u.createdAt,
      updatedAt: null,
      lastMessageAt: null,
    }));

    return res.json(mapped);
  } catch (err) {
    console.error("[admin][telegram/links] erro:", err);
    return res.status(500).json({ error: "Falha ao listar links do Telegram" });
  }
});

// Buscar vinculo usando mesma logica do bot (/id)
router.get("/telegram/links/lookup", async (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ error: "ADMIN_TOKEN nao configurado" });
  }
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const chatId = typeof req.query.chatId === "string" ? req.query.chatId.trim() : "";
  const fromId = typeof req.query.fromId === "string" ? req.query.fromId.trim() : "";

  const candidates: string[] = [];
  if (chatId) candidates.push(chatId);
  if (fromId && fromId !== chatId) candidates.push(fromId);

  if (!candidates.length) {
    return res.status(400).json({ error: "Informe chatId e/ou fromId" });
  }

  try {
    let found: LinkInfo | null = null;
    for (const candidate of candidates) {
      const user = await prisma.user.findFirst({
        where: { telegramChatId: candidate },
        select: {
          id: true,
          telegramId: true,
          telegramChatId: true,
          createdAt: true,
        },
      });
      if (user) {
        found = {
          id: user.id,
          chatId: user.telegramChatId ?? null,
          telegramUserId: user.telegramId,
          userId: user.id,
          userTelegramId: user.telegramId,
          createdAt: user.createdAt,
          updatedAt: null,
          lastMessageAt: null,
        };
        break;
      }
    }

    if (!found) {
      return res.status(404).json({ error: "Vinculo nao encontrado" });
    }

    return res.json(found);
  } catch (err) {
    console.error("[admin][telegram/links/lookup] erro:", err);
    return res.status(500).json({ error: "Falha ao buscar vinculo" });
  }
});

// Buscar vinculo por telegramUserId
router.get("/telegram/links/by-telegram-user/:telegramUserId", async (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ error: "ADMIN_TOKEN nao configurado" });
  }
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const telegramUserId = req.params.telegramUserId;
  if (!telegramUserId || !telegramUserId.trim()) {
    return res.status(400).json({ error: "telegramUserId obrigatorio" });
  }

  try {
    const user = await prisma.user.findFirst({
      where: {
        OR: [{ telegramChatId: telegramUserId.trim() }, { telegramId: telegramUserId.trim() }],
      },
      select: {
        id: true,
        telegramId: true,
        telegramChatId: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: "Vinculo nao encontrado" });
    }

    return res.json({
      chatId: user.telegramChatId ?? null,
      userId: user.id,
      telegramUserId: user.telegramId,
      createdAt: user.createdAt,
      updatedAt: null,
    });
  } catch (err) {
    console.error("[admin][telegram/links/by-telegram-user] erro:", err);
    return res.status(500).json({ error: "Falha ao buscar vinculo" });
  }
});

// Desvincular chatId
router.post("/telegram/unlink", async (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ error: "ADMIN_TOKEN nao configurado" });
  }
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const chatId = typeof req.body?.chatId === "number" ? req.body.chatId : Number(req.body?.chatId);
  if (!Number.isFinite(chatId)) {
    return res.status(400).json({ error: '"chatId" obrigatorio' });
  }

  try {
    const user = await prisma.user.findFirst({ where: { telegramChatId: String(chatId) } });
    if (!user) {
      return res.status(404).json({ error: "Vinculo nao encontrado" });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { telegramChatId: null },
    });

    return res.json({ ok: true, chatId: String(chatId) });
  } catch (err) {
    console.error("[admin][telegram/unlink] erro:", err);
    return res.status(500).json({ error: "Falha ao desvincular" });
  }
});

// Reapontar chatId para outro userId
router.post("/telegram/relink", async (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ error: "ADMIN_TOKEN nao configurado" });
  }
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const chatIdRaw = req.body?.chatId;
  const newUserIdRaw = req.body?.newUserId;
  const chatId = typeof chatIdRaw === "number" ? chatIdRaw : Number(chatIdRaw);
  const newUserId = typeof newUserIdRaw === "number" ? newUserIdRaw : Number(newUserIdRaw);

  if (!Number.isFinite(chatId)) {
    return res.status(400).json({ error: '"chatId" obrigatorio' });
  }
  if (!Number.isInteger(newUserId) || newUserId <= 0) {
    return res.status(400).json({ error: '"newUserId" deve ser inteiro > 0' });
  }

  try {
    const target = await prisma.user.findUnique({ where: { id: newUserId } });
    if (!target) {
      return res.status(404).json({ error: "Usuario de destino nao encontrado" });
    }

    const existing = await prisma.user.findFirst({ where: { telegramChatId: String(chatId) } });
    if (existing && existing.id !== target.id) {
      await prisma.user.update({ where: { id: existing.id }, data: { telegramChatId: null } });
    }

    await prisma.user.update({
      where: { id: target.id },
      data: { telegramChatId: String(chatId) },
    });

    return res.json({ ok: true, chatId: String(chatId), newUserId: target.id });
  } catch (err) {
    console.error("[admin][telegram/relink] erro:", err);
    return res.status(500).json({ error: "Falha ao relink" });
  }
});

async function migrateUserDataById(oldUserId: number, newTelegramId: string): Promise<MigrateByIdResult> {
  const oldUser = await prisma.user.findUnique({ where: { id: oldUserId } });
  if (!oldUser) {
    throw new Error(`Usuario antigo nao encontrado para id=${oldUserId}`);
  }

  const newUser = await getOrCreateUser(newTelegramId || API_TELEGRAM_ID);
  if (oldUser.id === newUser.id) {
    return {
      movedEntries: 0,
      movedDrafts: 0,
      movedCategories: 0,
      movedPlanning: 0,
      movedSessions: 0,
      oldUserId: oldUser.id,
      newUserId: newUser.id,
    };
  }

  const oldCategories = await prisma.category.findMany({ where: { userId: oldUser.id } });
  let movedCategories = 0;
  const categoryMap = new Map<number, number>();

  for (const cat of oldCategories) {
    const normalizedName = cat.normalizedName || normalizeCategoryName(cat.name);
    const existing = await prisma.category.findFirst({
      where: { userId: newUser.id, normalizedName },
    });

    let targetId = existing?.id;
    if (!targetId) {
      const created = await prisma.category.create({
        data: {
          userId: newUser.id,
          name: cat.name,
          normalizedName,
        },
      });
      targetId = created.id;
      movedCategories += 1;
    }

    categoryMap.set(cat.id, targetId);
  }

  let movedEntries = 0;
  for (const [oldCatId, newCatId] of categoryMap.entries()) {
    const updated = await prisma.expense.updateMany({
      where: { userId: oldUser.id, categoryId: oldCatId },
      data: { userId: newUser.id, categoryId: newCatId },
    });
    movedEntries += updated.count;
  }

  let movedDrafts = 0;
  for (const [oldCatId, newCatId] of categoryMap.entries()) {
    const updated = await prisma.expenseDraft.updateMany({
      where: { userId: oldUser.id, categoryId: oldCatId },
      data: { userId: newUser.id, categoryId: newCatId },
    });
    movedDrafts += updated.count;
  }

  let movedPlanning = 0;
  const oldPlanning = await prisma.planning.findUnique({ where: { userId: oldUser.id } });
  const newPlanning = await prisma.planning.findUnique({ where: { userId: newUser.id } });
  if (oldPlanning && !newPlanning) {
    await prisma.planning.update({
      where: { userId: oldUser.id },
      data: { userId: newUser.id },
    });
    movedPlanning = 1;
  }

  let movedSessions = 0;
  const oldSession = await prisma.userSession.findUnique({ where: { userId: oldUser.id } });
  if (oldSession) {
    await prisma.userSession.upsert({
      where: { userId: newUser.id },
      create: {
        userId: newUser.id,
        mode: oldSession.mode,
        draftId: oldSession.draftId,
        resetToken: oldSession.resetToken,
        resetTokenExpiresAt: oldSession.resetTokenExpiresAt,
      },
      update: {
        mode: oldSession.mode,
        draftId: oldSession.draftId,
        resetToken: oldSession.resetToken,
        resetTokenExpiresAt: oldSession.resetTokenExpiresAt,
      },
    });
    await prisma.userSession.delete({ where: { userId: oldUser.id } });
    movedSessions = 1;
  }

  await prisma.telegramLinkCode.updateMany({
    where: { userId: oldUser.id },
    data: { userId: newUser.id },
  });

  return {
    movedEntries,
    movedDrafts,
    movedCategories,
    movedPlanning,
    movedSessions,
    oldUserId: oldUser.id,
    newUserId: newUser.id,
  };
}

// TEMPORARIO: migrar por userId conhecido
router.post("/migrate-user-data-by-userid", async (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ error: "ADMIN_TOKEN nao configurado" });
  }

  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { oldUserId, newTelegramId } = req.body ?? {};
  if (!Number.isInteger(oldUserId) || oldUserId <= 0) {
    return res.status(400).json({ error: '"oldUserId" deve ser inteiro > 0' });
  }
  if (typeof newTelegramId !== "string" || !newTelegramId.trim()) {
    return res.status(400).json({ error: '"newTelegramId" obrigatorio' });
  }

  try {
    const result = await migrateUserDataById(oldUserId, newTelegramId.trim());
    return res.json(result);
  } catch (err) {
    console.error("[admin][migrate-user-data-by-userid] erro:", err);
    const message = err instanceof Error ? err.message : "Falha na migracao";
    return res.status(500).json({ error: message });
  }
});

router.post("/migrate-user-to-admin", async (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ error: "ADMIN_TOKEN nao configurado" });
  }

  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { fromUserId } = req.body ?? {};
  if (!Number.isInteger(fromUserId) || fromUserId <= 0) {
    return res.status(400).json({ error: '"fromUserId" deve ser inteiro > 0' });
  }

  try {
    const adminUser = await getAdminUser();
    const result = await migrateUserDataToTarget(fromUserId, adminUser.id);
    return res.json(result);
  } catch (err) {
    console.error("[admin][migrate-user-to-admin] erro:", err);
    const message = err instanceof Error ? err.message : "Falha na migracao";
    return res.status(500).json({ error: message });
  }
});

router.get("/reports/compare-all-months", async (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: "ADMIN_TOKEN nao configurado" });
  }
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const fromUserIdRaw = req.query.fromUserId;
  const fromUserId =
    typeof fromUserIdRaw === "string" && fromUserIdRaw.trim()
      ? Number(fromUserIdRaw.trim())
      : Number(fromUserIdRaw);
  if (!Number.isInteger(fromUserId) || fromUserId <= 0) {
    return res.status(400).json({ error: '"fromUserId" deve ser inteiro > 0' });
  }

  try {
    const adminUser = await getAdminUser();
    const adminId = adminUser.id;

    const rows = await prisma.$queryRaw<
      { month: string; userId: number; count: bigint; total: bigint | null }[]
    >`
      SELECT
        TO_CHAR(DATE_TRUNC('month', "date" AT TIME ZONE 'America/Bahia'), 'YYYY-MM') AS month,
        "userId",
        COUNT(*)::bigint AS count,
        SUM("amountCents")::bigint AS total
      FROM "Expense"
      WHERE "userId" IN (${fromUserId}, ${adminId})
      GROUP BY month, "userId"
      ORDER BY month ASC
    `;

    const months = new Set<string>();
    const map = new Map<string, { old_count: number; old_total: number; current_count: number; current_total: number }>();

    rows.forEach((row) => {
      months.add(row.month);
      const key = row.month;
      const entry =
        map.get(key) ?? { old_count: 0, old_total: 0, current_count: 0, current_total: 0 };
      if (row.userId === fromUserId) {
        entry.old_count = Number(row.count ?? 0);
        entry.old_total = Number(row.total ?? 0);
      } else if (row.userId === adminId) {
        entry.current_count = Number(row.count ?? 0);
        entry.current_total = Number(row.total ?? 0);
      }
      map.set(key, entry);
    });

    const header = "month,old_count,old_total,current_count,current_total";
    const lines = Array.from(months)
      .sort()
      .map((month) => {
        const data = map.get(month) ?? {
          old_count: 0,
          old_total: 0,
          current_count: 0,
          current_total: 0,
        };
        return [month, data.old_count, data.old_total, data.current_count, data.current_total].join(",");
      });

    const csv = [header, ...lines].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=compare-${fromUserId}-vs-admin.csv`);
    return res.status(200).send(csv);
  } catch (err) {
    console.error("[admin][reports/compare-all-months] erro:", err);
    return res.status(500).json({ error: "Falha ao gerar relatorio" });
  }
});

router.get("/debug/user-ids", async (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: "ADMIN_TOKEN nao configurado" });
  }
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const rows = await prisma.expense.groupBy({
      by: ["userId"],
      _count: true,
      _sum: { amountCents: true },
      orderBy: { userId: "asc" },
    });

    return res.json(
      rows.map((r) => ({
        userId: r.userId,
        count: r._count,
        amountCents: r._sum.amountCents ?? 0,
      })),
    );
  } catch (err) {
    console.error("[admin][debug/user-ids] erro:", err);
    return res.status(500).json({ error: "Falha ao listar userIds" });
  }
});

router.get("/debug/expense-users", async (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: "ADMIN_TOKEN nao configurado" });
  }
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const rows = await prisma.expense.groupBy({
      by: ["userId"],
      _count: true,
      _sum: { amountCents: true },
      _min: { date: true },
      _max: { date: true },
    });

    const mapped = rows
      .map((r) => ({
        userId: r.userId,
        count: r._count,
        sumCents: r._sum.amountCents ?? 0,
        minDate: r._min.date ? new Date(r._min.date) : null,
        maxDate: r._max.date ? new Date(r._max.date) : null,
      }))
      .sort((a, b) => b.count - a.count);

    return res.json(mapped);
  } catch (err) {
    console.error("[admin][debug/expense-users] erro:", err);
    return res.status(500).json({ error: "Falha ao listar despesas por usuario" });
  }
});

export default router;
