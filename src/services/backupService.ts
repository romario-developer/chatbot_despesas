import fs from "fs";
import path from "path";

import { Prisma } from "@prisma/client";

import { prisma } from "../infra/db/prisma";
import { TZ } from "../utils/dates";
import { getMonthRangeFromMonthYear, parseFromToQuery } from "../utils/dateRange";

type SnapshotCounts = {
  users: number;
  categories: number;
  cards: number;
  installmentGroups: number;
  cardPayments: number;
  expenses: number;
  expenseDrafts: number;
  planning: number;
  userSessions: number;
  telegramLinkCodes: number;
  credits: number;
};

export type BackupPayload = {
  meta: {
    createdAt: string;
    version: number;
    counts: SnapshotCounts;
  };
  users: any[];
  categories: any[];
  cards: any[];
  installmentGroups: any[];
  cardPayments: any[];
  expenses: any[];
  expenseDrafts: any[];
  planning: any[];
  userSessions: any[];
  telegramLinkCodes: any[];
  credits: any[];
};

export type BackupFilters = {
  month?: string;
  from?: string;
  to?: string;
};

export type BackupSnapshot = {
  meta: {
    generatedAt: string;
    filters: BackupFilters;
    counts: SnapshotCounts;
  };
  data: {
    users: any[];
    categories: any[];
    cards: any[];
    installmentGroups: any[];
    cardPayments: any[];
    expenses: any[];
    expenseDrafts: any[];
    planning: any[];
    userSessions: any[];
    telegramLinkCodes: any[];
    credits: any[];
  };
};

export async function runBackup() {
  const backupDir = resolveBackupDir();
  fs.mkdirSync(backupDir, { recursive: true });

  const now = new Date();
  const fileName = `backup-${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}.json`;
  const filePath = path.join(backupDir, fileName);

  const [users, categories, cards, installmentGroups, cardPayments, expenses, expenseDrafts, planning, userSessions, telegramLinkCodes, credits] =
    await Promise.all([
      prisma.user.findMany(),
      prisma.category.findMany(),
      prisma.card.findMany(),
      prisma.installmentGroup.findMany(),
      prisma.cardPayment.findMany(),
      prisma.expense.findMany(),
      prisma.expenseDraft.findMany(),
      prisma.planning.findMany(),
      prisma.userSession.findMany(),
      prisma.telegramLinkCode.findMany(),
      prisma.credit.findMany(),
    ]);

  const counts: SnapshotCounts = {
    users: users.length,
    categories: categories.length,
    cards: cards.length,
    installmentGroups: installmentGroups.length,
    cardPayments: cardPayments.length,
    expenses: expenses.length,
    expenseDrafts: expenseDrafts.length,
    planning: planning.length,
    userSessions: userSessions.length,
    telegramLinkCodes: telegramLinkCodes.length,
    credits: credits.length,
  };

  const payload: BackupPayload = {
    meta: {
      createdAt: now.toISOString(),
      version: 1,
      counts,
    },
    users,
    categories,
    cards,
    installmentGroups,
    cardPayments,
    expenses,
    expenseDrafts,
    planning,
    userSessions,
    telegramLinkCodes,
    credits,
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");

  return { filePath, payload };
}

export async function exportSnapshot(filters: BackupFilters = {}) {
  const sanitizedFilters: BackupFilters = {
    month: filters.month?.trim() || undefined,
    from: filters.from?.trim() || undefined,
    to: filters.to?.trim() || undefined,
  };

  const expenseWhere = buildExpenseWhereClause(sanitizedFilters);

  const [users, categories, cards, installmentGroups, cardPayments, expenses, expenseDrafts, planning, userSessions, telegramLinkCodes, credits] =
    await Promise.all([
      prisma.user.findMany(),
      prisma.category.findMany(),
      prisma.card.findMany(),
      prisma.installmentGroup.findMany(),
      prisma.cardPayment.findMany(),
      prisma.expense.findMany({ where: expenseWhere, include: { category: true } }),
      prisma.expenseDraft.findMany(),
      prisma.planning.findMany(),
      prisma.userSession.findMany(),
      prisma.telegramLinkCode.findMany(),
      prisma.credit.findMany(),
    ]);

  const counts: SnapshotCounts = {
    users: users.length,
    categories: categories.length,
    cards: cards.length,
    installmentGroups: installmentGroups.length,
    cardPayments: cardPayments.length,
    expenses: expenses.length,
    expenseDrafts: expenseDrafts.length,
    planning: planning.length,
    userSessions: userSessions.length,
    telegramLinkCodes: telegramLinkCodes.length,
    credits: credits.length,
  };

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      filters: sanitizedFilters,
      counts,
    },
    data: {
      users,
      categories,
      cards,
      installmentGroups,
      cardPayments,
      expenses,
      expenseDrafts,
      planning,
      userSessions,
      telegramLinkCodes,
      credits,
    },
  };
}

function buildExpenseWhereClause(filters: BackupFilters): Prisma.ExpenseWhereInput {
  const where: Prisma.ExpenseWhereInput = {};

  if (filters.month) {
    const match = filters.month.match(/^(\d{4})-(\d{2})$/);
    if (!match) {
      throw new Error('month deve estar no formato YYYY-MM');
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const { start, endExclusive } = getMonthRangeFromMonthYear(month, year, TZ);
    where.date = { gte: start, lt: endExclusive };
  } else {
    const { start, endExclusive, error } = parseFromToQuery(filters.from, filters.to, TZ);
    if (error) {
      throw new Error(error);
    }
    if (start || endExclusive) {
      where.date = {
        ...(start ? { gte: start } : {}),
        ...(endExclusive ? { lt: endExclusive } : {}),
      };
    }
  }

  return where;
}

function resolveBackupDir() {
  const dir = process.env.BACKUP_DIR;
  if (dir) return path.resolve(dir);
  return path.resolve("/tmp/backups");
}
