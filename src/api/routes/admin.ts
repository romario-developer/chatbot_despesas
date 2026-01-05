import { Router } from "express";

import { prisma } from "../../db/prisma";
import { runBackup } from "../../services/backupService";
import { getOrCreateUser } from "../../services/userService";
import { normalizeCategoryName } from "../../utils/normalize";
import { API_TELEGRAM_ID } from "../../utils/systemUsers";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  console.warn("[admin] ADMIN_TOKEN nÆo definido; /api/admin/backup ficar  inativo.");
}

const router = Router();

router.get("/backup", async (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: "ADMIN_TOKEN nÆo configurado" });
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
      where: { OR: [{ telegramId: telegramUserId.trim() }, { telegramChatId: telegramUserId.trim() }] },
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

export default router;
