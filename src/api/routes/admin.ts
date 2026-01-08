import { Router } from "express";

import { prisma } from "../../db/prisma";
import { runBackup } from "../../services/backupService";
import { getOrCreateUser, getAdminUser } from "../../services/userService";
import { normalizeCategoryName } from "../../utils/normalize";
import { API_TELEGRAM_ID } from "../../utils/systemUsers";
import { dayjs, TZ } from "../../utils/dates";
import { getMonthRangeFromMonthYear } from "../../utils/dateRange";
import { normalizeEmail } from "../../utils/email";
import { generateTempPassword, hashPassword } from "../../utils/password";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  console.warn("[admin] ADMIN_TOKEN nao definido; /api/admin/backup ficara inativo.");
}

const router = Router();

function requireAdminToken(req: any, res: any) {
  if (!ADMIN_TOKEN) {
    res.status(503).json({ error: "ADMIN_TOKEN nao configurado" });
    return false;
  }
  const token =
    typeof req.headers["x-admin-token"] === "string"
      ? req.headers["x-admin-token"].trim()
      : req.headers.authorization?.replace(/^Bearer /i, "").trim();
  if (token !== ADMIN_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function requireAdminSecret(req: any, res: any) {
  if (!ADMIN_TOKEN) {
    res.status(503).json({ error: "ADMIN_TOKEN nao configurado" });
    return false;
  }
  const token =
    typeof req.headers["x-admin-secret"] === "string" ? req.headers["x-admin-secret"].trim() : "";
  if (!token || token !== ADMIN_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

router.post("/users", async (req, res) => {
  if (!requireAdminSecret(req, res)) return;

  const rawEmail = req.body?.email;
  const normalizedEmail = normalizeEmail(rawEmail);
  if (!normalizedEmail) {
    return res.status(400).json({ error: "email invalido ou ausente" });
  }

  const rawName = req.body?.name;
  const name =
    typeof rawName === "string" && rawName.trim().length ? rawName.trim().slice(0, 120) : null;

  let tempPassword =
    typeof req.body?.tempPassword === "string" ? req.body.tempPassword.trim() : "";
  if (!tempPassword) {
    tempPassword = generateTempPassword(12);
  } else if (tempPassword.length < 8) {
    return res.status(400).json({ error: "tempPassword deve ter pelo menos 8 caracteres" });
  }

  const existing = await prisma.user.findFirst({
    where: {
      OR: [{ email: normalizedEmail }, { telegramId: normalizedEmail }],
    },
    select: { id: true },
  });
  if (existing) {
    return res.status(409).json({ error: "Email ja cadastrado" });
  }

  const passwordHash = hashPassword(tempPassword);
  const created = await prisma.user.create({
    data: {
      telegramId: normalizedEmail,
      email: normalizedEmail,
      name: name ?? undefined,
      passwordHash,
      mustChangePassword: true,
    },
  });

  return res.status(201).json({
    id: created.id,
    email: created.email,
    name: created.name,
    tempPassword,
    mustChangePassword: created.mustChangePassword,
  });
});

router.get("/backup", async (req, res) => {
  if (!requireAdminToken(req, res)) return;

  try {
    const { filePath, payload } = await runBackup();
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

router.post("/migrate-user-data", async (req, res) => {
  if (!requireAdminToken(req, res)) return;

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

router.post("/migrate-user-data-by-userid", async (req, res) => {
  if (!requireAdminToken(req, res)) return;

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

router.get("/exports/expenses.csv", async (req, res) => {
  if (!requireAdminToken(req, res)) return;

  const month = typeof req.query.month === "string" ? req.query.month.trim() : "";
  const fromStr = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const toStr = typeof req.query.to === "string" ? req.query.to.trim() : "";
  const source = typeof req.query.source === "string" ? req.query.source.trim() : "";
  const category = typeof req.query.category === "string" ? req.query.category.trim() : "";

  const adminUser = await getAdminUser();
  const where: any = { userId: adminUser.id };

  if (month) {
    const match = month.match(/^(\d{4})-(\d{2})$/);
    if (!match) {
      return res.status(400).json({ error: 'month deve ser YYYY-MM' });
    }
    const year = Number(match[1]);
    const m = Number(match[2]);
    const { start, endExclusive } = getMonthRangeFromMonthYear(m, year, TZ);
    where.date = { gte: start, lt: endExclusive };
  } else {
    if (fromStr) {
      const from = dayjs.tz(fromStr, "YYYY-MM-DD", TZ);
      if (!from.isValid()) return res.status(400).json({ error: 'from invalido (YYYY-MM-DD)' });
      where.date = { ...(where.date || {}), gte: from.toDate() };
    }
    if (toStr) {
      const to = dayjs.tz(toStr, "YYYY-MM-DD", TZ);
      if (!to.isValid()) return res.status(400).json({ error: 'to invalido (YYYY-MM-DD)' });
      const end = to.add(1, "day");
      where.date = { ...(where.date || {}), lt: end.toDate() };
    }
  }

  if (source) {
    where.source = source;
  }
  if (category) {
    where.category = { is: { name: { contains: category, mode: "insensitive" } } };
  }

  try {
    const expenses = await prisma.expense.findMany({
      where,
      include: { category: true },
      orderBy: { date: "asc" },
    });

    const periodLabel = month || (fromStr && toStr ? `${fromStr}_to_${toStr}` : fromStr || toStr || "all");
    const header = "date,description,category,amount,source";
    const lines = expenses.map((e) => {
      const date = e.date.toISOString().slice(0, 10);
      const description = (e.description || "").replace(/"/g, '""');
      const categoryName = (e.category?.name || "").replace(/"/g, '""');
      const amount = ((e.amountCents ?? 0) / 100).toFixed(2);
      const src = (e.source || "").replace(/"/g, '""');
      return `${date},"${description}","${categoryName}",${amount},${src}`;
    });

    const csv = [header, ...lines].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="expenses_${periodLabel}.csv"`);
    return res.status(200).send(csv);
  } catch (err) {
    console.error("[admin][exports/expenses.csv] erro:", err);
    return res.status(500).json({ error: "Falha ao exportar despesas" });
  }
});

export default router;
