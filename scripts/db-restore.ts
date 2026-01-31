import fs from "fs";
import path from "path";

import { prisma } from "../src/infra/db/prisma";

type BackupData = {
  users?: any[];
  categories?: any[];
  expenses?: any[];
  expenseDrafts?: any[];
  planning?: any[];
  userSessions?: any[];
  telegramLinkCodes?: any[];
};

function parseArgs() {
  const args = process.argv.slice(2);
  const fileFlagIndex = args.findIndex((a) => a === "--file" || a === "-f");
  if (fileFlagIndex === -1 || !args[fileFlagIndex + 1]) {
    throw new Error('Use --file <caminho> para indicar o JSON de backup.');
  }
  return { file: path.resolve(args[fileFlagIndex + 1]) };
}

async function ensureEmpty() {
  const counts = await Promise.all([
    prisma.expense.count(),
    prisma.expenseDraft.count(),
    prisma.category.count(),
    prisma.user.count(),
    prisma.planning.count(),
    prisma.userSession.count(),
    prisma.telegramLinkCode.count(),
  ]);

  const hasData = counts.some((c) => c > 0);
  if (hasData) {
    throw new Error("Banco não está vazio. Rode db:reset antes de restaurar.");
  }
}

async function resetSequences() {
  const seqs = ["User", "Category", "Expense", "Planning", "UserSession"];
  for (const table of seqs) {
    const sql = `
      SELECT setval(
        pg_get_serial_sequence('"${table}"','id'),
        GREATEST((SELECT COALESCE(MAX("id"), 0) FROM "${table}"), 0) + 1,
        false
      )
    `;
    await prisma.$executeRawUnsafe(sql);
  }
}

async function main() {
  const { file } = parseArgs();
  if (!fs.existsSync(file)) throw new Error(`Arquivo não encontrado: ${file}`);

  const raw = fs.readFileSync(file, "utf-8");
  const data: BackupData = JSON.parse(raw);

  await ensureEmpty();

  const users = data.users ?? [];
  const categories = data.categories ?? [];
  const expenses = data.expenses ?? [];
  const expenseDrafts = data.expenseDrafts ?? [];
  const planning = data.planning ?? [];
  const userSessions = data.userSessions ?? [];
  const telegramLinkCodes = data.telegramLinkCodes ?? [];

  console.log("[restore] iniciando. Contagens:", {
    users: users.length,
    categories: categories.length,
    expenses: expenses.length,
    expenseDrafts: expenseDrafts.length,
    planning: planning.length,
    userSessions: userSessions.length,
    telegramLinkCodes: telegramLinkCodes.length,
  });

  await prisma.$transaction(async (tx) => {
    if (users.length) {
      await tx.user.createMany({ data: users, skipDuplicates: false });
    }
    if (categories.length) {
      await tx.category.createMany({ data: categories, skipDuplicates: false });
    }
    if (expenses.length) {
      await tx.expense.createMany({ data: expenses, skipDuplicates: false });
    }
    if (expenseDrafts.length) {
      await tx.expenseDraft.createMany({ data: expenseDrafts, skipDuplicates: false });
    }
    if (planning.length) {
      await tx.planning.createMany({ data: planning, skipDuplicates: false });
    }
    if (userSessions.length) {
      await tx.userSession.createMany({ data: userSessions, skipDuplicates: false });
    }
    if (telegramLinkCodes.length) {
      await tx.telegramLinkCode.createMany({ data: telegramLinkCodes, skipDuplicates: false });
    }
  });

  await resetSequences();

  console.log("[restore] concluído a partir de", file);
}

main()
  .catch((err) => {
    console.error("[restore] falhou:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
