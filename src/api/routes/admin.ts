import { Router } from "express";

import { prisma } from "../../infra/db/prisma";
import { runBackup, exportSnapshot, type BackupFilters } from "../../services/backupService";
import { getOrCreateUser, getAdminUser } from "../../services/userService";
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

function buildBackupFilters(req: any): BackupFilters {
  return {
    month: typeof req.query.month === "string" ? req.query.month.trim() : undefined,
    from: typeof req.query.from === "string" ? req.query.from.trim() : undefined,
    to: typeof req.query.to === "string" ? req.query.to.trim() : undefined,
  };
}

function buildPeriodLabel(filters: BackupFilters) {
  if (filters.month) return filters.month;
  if (filters.from && filters.to) return `${filters.from}_to_${filters.to}`;
  return filters.from || filters.to || "all";
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

router.get("/backup/export", async (req, res) => {
  if (!requireAdminToken(req, res)) return;
  try {
    const filters = buildBackupFilters(req);
    const snapshot = await exportSnapshot(filters);
    return res.json(snapshot);
  } catch (err) {
    console.error("[admin][backup/export] falhou:", err);
    const message = err instanceof Error ? err.message : "Falha ao processar filtros";
    return res.status(400).json({ error: message });
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

router.get("/backup/entries.csv", async (req, res) => {
  if (!requireAdminToken(req, res)) return;
  try {
    const filters = buildBackupFilters(req);
    const snapshot = await exportSnapshot(filters);
    const entries = snapshot.data.expenses;
    const periodLabel = buildPeriodLabel(filters);
    const header = "date,description,category,amount,source";
    const lines = entries.map((e) => {
      const date = e.date.toISOString().slice(0, 10);
      const description = (e.description || "").replace(/"/g, '""');
      const category = (e.category?.name || "").replace(/"/g, '""');
      const amount = ((e.amountCents ?? 0) / 100).toFixed(2);
      const src = (e.source || "").replace(/"/g, '""');
      return `${date},"${description}","${category}",${amount},${src}`;
    });
    const csv = [header, ...lines].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="backup_entries_${periodLabel}.csv"`);
    return res.status(200).send(csv);
  } catch (err) {
    console.error("[admin][backup/entries.csv] erro:", err);
    const message = err instanceof Error ? err.message : "Falha ao exportar despesas";
    return res.status(500).json({ error: message });
  }
});

export default router;
