import { Router } from "express";

import { prisma } from "../../db/prisma";
import { runBackup } from "../../services/backupService";
import { getOrCreateUser, getAdminUser } from "../../services/userService";
import { normalizeCategoryName } from "../../utils/normalize";
import { API_TELEGRAM_ID } from "../../utils/systemUsers";
import { dayjs, TZ } from "../../utils/dates";
import { getMonthRangeFromMonthYear } from "../../utils/dateRange";
import { normalizeEmail } from "../../utils/email";
import { hashPassword } from "../../utils/password";

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

  const rawPassword = typeof req.body?.password === "string" ? req.body.password.trim() : "";
  if (!rawPassword || rawPassword.length < 8) {
    return res.status(400).json({ error: "password deve ter pelo menos 8 caracteres" });
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

  const passwordHash = hashPassword(rawPassword);
  const created = await prisma.user.create({
    data: {
      telegramId: normalizedEmail,
      email: normalizedEmail,
      name: name ?? undefined,
      passwordHash,
      mustChangePassword: false,
    },
  });

  return res.status(201).json({
    id: created.id,
    email: created.email,
    name: created.name,
  });
});

router.post("/telegram/unlink", async (req, res) => {
  if (!requireAdminSecret(req, res)) return;

  const rawChatId = typeof req.body?.telegramChatId === "string" ? req.body.telegramChatId.trim() : "";
  const rawUserId = typeof req.body?.telegramUserId === "string" ? req.body.telegramUserId.trim() : "";

  if (!rawChatId && !rawUserId) {
    return res.status(400).json({ error: "telegramChatId ou telegramUserId obrigatorio" });
  }

  const orFilters: { telegramChatId?: string; telegramId?: string }[] = [];
  if (rawChatId) orFilters.push({ telegramChatId: rawChatId });
  if (rawUserId) orFilters.push({ telegramId: rawUserId });

  const user = await prisma.user.findFirst({
    where: { OR: orFilters },
    select: { id: true, email: true, telegramChatId: true, telegramId: true },
  });

  if (!user) {
    return res.status(404).json({ error: "Vinculo nao encontrado" });
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { telegramChatId: null, telegramId: null },
    }),
    prisma.telegramLinkCode.deleteMany({ where: { userId: user.id } }),
  ]);

  return res.json({
    ok: true,
    unlinkedUserId: user.id,
    email: user.email ?? null,
    previousTelegramChatId: user.telegramChatId ?? null,
    previousTelegramUserId: user.telegramId ?? null,
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
  movedLinkCodes: number;
  oldUserId: number | null;
  newUserId: number | null;
};

type MigrateByIdResult = MigrateResult;

async function resolveUserByTelegramId(telegramId: string) {
  return prisma.user.findFirst({
    where: { OR: [{ telegramId }, { telegramChatId: telegramId }] },
  });
}

type UserCount = { userId: number; count: number };

type DominantUserResult =
  | { ok: true; userId: number; source: string; total: number; counts: UserCount[] }
  | { ok: false; reason: string; source: string; total: number; counts: UserCount[] };

const MAJORITY_SHARE = 0.5;
const SIGNIFICANT_SHARE = 0.25;

async function loadUserIdCounts(): Promise<{ source: string; counts: UserCount[] }> {
  const expenseCounts = await prisma.expense.groupBy({
    by: ["userId"],
    _count: { _all: true },
  });
  if (expenseCounts.length) {
    return {
      source: "expenses",
      counts: expenseCounts.map((row) => ({ userId: row.userId, count: row._count._all })),
    };
  }

  const categoryCounts = await prisma.category.groupBy({
    by: ["userId"],
    _count: { _all: true },
  });
  if (categoryCounts.length) {
    return {
      source: "categories",
      counts: categoryCounts.map((row) => ({ userId: row.userId, count: row._count._all })),
    };
  }

  const draftCounts = await prisma.expenseDraft.groupBy({
    by: ["userId"],
    _count: { _all: true },
  });
  if (draftCounts.length) {
    return {
      source: "drafts",
      counts: draftCounts.map((row) => ({ userId: row.userId, count: row._count._all })),
    };
  }

  return { source: "none", counts: [] };
}

function findDominantUserId(counts: UserCount[], source: string): DominantUserResult {
  if (!counts.length) {
    return { ok: false, reason: "no_data", source, total: 0, counts };
  }

  const sorted = [...counts].sort((a, b) => b.count - a.count);
  const total = sorted.reduce((sum, item) => sum + item.count, 0);

  if (sorted.length === 1) {
    return { ok: true, userId: sorted[0].userId, source, total, counts: sorted };
  }

  const top = sorted[0];
  const topShare = total > 0 ? top.count / total : 0;
  const significant = sorted.filter((item) => total > 0 && item.count / total >= SIGNIFICANT_SHARE);

  if (topShare <= MAJORITY_SHARE || significant.length > 1) {
    return {
      ok: false,
      reason: "multiple_users",
      source,
      total,
      counts: sorted,
    };
  }

  return { ok: true, userId: top.userId, source, total, counts: sorted };
}

async function migrateUserDataToUserId(oldUserId: number, newUserId: number): Promise<MigrateResult> {
  const oldUser = await prisma.user.findUnique({ where: { id: oldUserId } });
  if (!oldUser) {
    throw new Error(`Usuario antigo nao encontrado para id=${oldUserId}`);
  }

  const newUser = await prisma.user.findUnique({ where: { id: newUserId } });
  if (!newUser) {
    throw new Error(`Usuario destino nao encontrado para id=${newUserId}`);
  }

  if (oldUser.id === newUser.id) {
    return {
      movedEntries: 0,
      movedDrafts: 0,
      movedCategories: 0,
      movedPlanning: 0,
      movedSessions: 0,
      movedLinkCodes: 0,
      oldUserId: oldUser.id,
      newUserId: newUser.id,
    };
  }

  const oldCategories = await prisma.category.findMany({ where: { userId: oldUser.id } });
  let movedCategories = 0;
  const categoryMap = new Map<number, number>();
  const categoriesToDelete: number[] = [];

  for (const cat of oldCategories) {
    const normalizedName = cat.normalizedName || normalizeCategoryName(cat.name);
    const existing = await prisma.category.findFirst({
      where: { userId: newUser.id, normalizedName },
    });

    let targetId = existing?.id;
    if (targetId) {
      categoriesToDelete.push(cat.id);
    } else {
      await prisma.category.update({
        where: { id: cat.id },
        data: { userId: newUser.id, normalizedName },
      });
      targetId = cat.id;
    }

    movedCategories += 1;
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

  if (categoriesToDelete.length) {
    await prisma.category.deleteMany({ where: { id: { in: categoriesToDelete } } });
  }

  let movedPlanning = 0;
  const oldPlanning = await prisma.planning.findUnique({ where: { userId: oldUser.id } });
  const newPlanning = await prisma.planning.findUnique({ where: { userId: newUser.id } });
  if (oldPlanning) {
    if (newPlanning) {
      const oldData =
        typeof oldPlanning.data === "object" && oldPlanning.data ? (oldPlanning.data as any) : {};
      const newData =
        typeof newPlanning.data === "object" && newPlanning.data ? (newPlanning.data as any) : {};
      await prisma.planning.update({
        where: { id: newPlanning.id },
        data: { data: { ...oldData, ...newData } },
      });
      await prisma.planning.delete({ where: { userId: oldUser.id } }).catch(() => {});
    } else {
      await prisma.planning.update({
        where: { userId: oldUser.id },
        data: { userId: newUser.id },
      });
    }
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

  const linkUpdate = await prisma.telegramLinkCode.updateMany({
    where: { userId: oldUser.id },
    data: { userId: newUser.id },
  });

  return {
    movedEntries,
    movedDrafts,
    movedCategories,
    movedPlanning,
    movedSessions,
    movedLinkCodes: linkUpdate.count,
    oldUserId: oldUser.id,
    newUserId: newUser.id,
  };
}

async function migrateUserData(oldTelegramId: string, newTelegramId: string): Promise<MigrateResult> {
  const oldUser = await resolveUserByTelegramId(oldTelegramId);
  if (!oldUser) {
    throw new Error(`Usuario antigo nao encontrado para telegramId="${oldTelegramId}"`);
  }

  const newUser = await getOrCreateUser(newTelegramId || API_TELEGRAM_ID);
  return migrateUserDataToUserId(oldUser.id, newUser.id);
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

router.post("/claim-data", async (req, res) => {
  if (!requireAdminSecret(req, res)) return;

  const rawEmail = req.body?.email;
  const normalizedEmail = normalizeEmail(rawEmail);
  if (!normalizedEmail) {
    return res.status(400).json({ error: "email invalido ou ausente" });
  }

  const targetUser = await prisma.user.findFirst({
    where: { email: normalizedEmail },
    select: { id: true, email: true },
  });
  if (!targetUser) {
    return res.status(404).json({ error: "Usuario nao encontrado" });
  }

  const rawFromUserId = req.body?.fromUserId;
  let fromUserId: number | null = null;
  if (typeof rawFromUserId !== "undefined" && rawFromUserId !== null) {
    const parsed =
      typeof rawFromUserId === "number"
        ? rawFromUserId
        : typeof rawFromUserId === "string"
          ? Number.parseInt(rawFromUserId, 10)
          : NaN;
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return res.status(400).json({ error: '"fromUserId" deve ser inteiro > 0' });
    }
    fromUserId = parsed;
  } else {
    const { source, counts } = await loadUserIdCounts();
    const dominant = findDominantUserId(counts, source);
    if (!dominant.ok) {
      const error =
        dominant.reason === "no_data"
          ? "Nenhum dado legado encontrado. Informe fromUserId para migrar manualmente."
          : "Multiplos userId encontrados. Informe fromUserId para migrar manualmente.";
      return res.status(409).json({
        error,
        source: dominant.source,
        counts: dominant.counts,
      });
    }
    fromUserId = dominant.userId;
  }

  try {
    const result = await migrateUserDataToUserId(fromUserId, targetUser.id);
    return res.json({
      migrated: {
        expenses: result.movedEntries,
        drafts: result.movedDrafts,
        categories: result.movedCategories,
        planning: result.movedPlanning,
        sessions: result.movedSessions,
        linkCodes: result.movedLinkCodes,
      },
      fromUserId: result.oldUserId,
      toUserId: result.newUserId,
    });
  } catch (err) {
    console.error("[admin][claim-data] erro:", err);
    const message = err instanceof Error ? err.message : "Falha na migracao";
    return res.status(500).json({ error: message });
  }
});

async function migrateUserDataById(oldUserId: number, newTelegramId: string): Promise<MigrateByIdResult> {
  const newUser = await getOrCreateUser(newTelegramId || API_TELEGRAM_ID);
  return migrateUserDataToUserId(oldUserId, newUser.id);
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
