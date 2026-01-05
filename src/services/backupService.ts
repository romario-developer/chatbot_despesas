import fs from "fs";
import path from "path";

import { prisma } from "../db/prisma";

type BackupCounts = {
  users: number;
  categories: number;
  expenses: number;
  expenseDrafts: number;
  planning: number;
  userSessions: number;
  telegramLinkCodes: number;
};

export type BackupPayload = {
  meta: {
    createdAt: string;
    version: number;
    counts: BackupCounts;
  };
  users: any[];
  categories: any[];
  expenses: any[];
  expenseDrafts: any[];
  planning: any[];
  userSessions: any[];
  telegramLinkCodes: any[];
};

export async function runBackup() {
  const backupDir = resolveBackupDir();
  fs.mkdirSync(backupDir, { recursive: true });

  const now = new Date();
  const fileName = `backup-${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}.json`;
  const filePath = path.join(backupDir, fileName);

  const [users, categories, expenses, expenseDrafts, planning, userSessions, telegramLinkCodes] =
    await Promise.all([
      prisma.user.findMany(),
      prisma.category.findMany(),
      prisma.expense.findMany(),
      prisma.expenseDraft.findMany(),
      prisma.planning.findMany(),
      prisma.userSession.findMany(),
      prisma.telegramLinkCode.findMany(),
    ]);

  const counts: BackupCounts = {
    users: users.length,
    categories: categories.length,
    expenses: expenses.length,
    expenseDrafts: expenseDrafts.length,
    planning: planning.length,
    userSessions: userSessions.length,
    telegramLinkCodes: telegramLinkCodes.length,
  };

  const payload: BackupPayload = {
    meta: {
      createdAt: now.toISOString(),
      version: 1,
      counts,
    },
    users,
    categories,
    expenses,
    expenseDrafts,
    planning,
    userSessions,
    telegramLinkCodes,
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");

  return { filePath, payload };
}

function resolveBackupDir() {
  const dir = process.env.BACKUP_DIR;
  if (dir) return path.resolve(dir);
  // Render permite escrita em /tmp
  return path.resolve("/tmp/backups");
}
