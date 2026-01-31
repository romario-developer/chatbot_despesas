import { prisma } from "../src/infra/db/prisma";
import { getAdminUser } from "../src/services/userService";

type TableName = "expense" | "expenseDraft" | "planning" | "userSession" | "telegramLinkCode";

const TABLES: TableName[] = ["expense", "expenseDraft", "planning", "userSession", "telegramLinkCode"];

const MODELS: Record<TableName, any> = {
  expense: prisma.expense,
  expenseDraft: prisma.expenseDraft,
  planning: prisma.planning,
  userSession: prisma.userSession,
  telegramLinkCode: prisma.telegramLinkCode,
};

async function distinctUserIds(table: TableName): Promise<number[]> {
  const rows = await MODELS[table].findMany({
    distinct: ["userId"],
    select: { userId: true },
  });
  return rows.map((r: any) => r.userId).filter((id: number | null) => typeof id === "number");
}

async function countByUser(table: TableName): Promise<Record<number, { count: number }>> {
  const rows = await MODELS[table].groupBy({
    by: ["userId"],
    _count: true,
  });
  return rows.reduce((acc: Record<number, { count: number }>, row: any) => {
    acc[row.userId] = { count: row._count };
    return acc;
  }, {});
}

async function migrateUserIds(adminId: number, userIds: number[]) {
  await prisma.$transaction(async (tx) => {
    for (const userId of userIds) {
      for (const table of TABLES) {
        const model = (tx as any)[table];
        await model.updateMany({
          where: { userId },
          data: { userId: adminId },
        });
      }
    }
  });
}

async function main() {
  const adminUser = await getAdminUser();
  const adminId = adminUser.id;

  console.log("[migrate-all-to-admin] admin userId:", adminId);

  const distincts = await Promise.all(TABLES.map((t) => distinctUserIds(t)));
  const allUserIds = new Set<number>();
  distincts.forEach((ids) => ids.forEach((id) => allUserIds.add(id)));

  const targets = Array.from(allUserIds).filter((id) => id !== adminId);
  console.log("[migrate-all-to-admin] userIds encontrados (exceto admin):", targets);

  const before: Record<TableName, Record<number, { count: number }>> = {} as any;
  for (const table of TABLES) {
    before[table] = await countByUser(table);
  }
  console.log("[migrate-all-to-admin] contagem antes:", before);

  if (!targets.length) {
    console.log("[migrate-all-to-admin] nada a migrar.");
    return;
  }

  console.log("[migrate-all-to-admin] iniciando migracao em transacao...");
  await migrateUserIds(adminId, targets);
  console.log("[migrate-all-to-admin] migracao concluida.");

  const after: Record<TableName, Record<number, { count: number }>> = {} as any;
  for (const table of TABLES) {
    after[table] = await countByUser(table);
  }
  console.log("[migrate-all-to-admin] contagem depois:", after);
}

main()
  .catch((err) => {
    console.error("[migrate-all-to-admin] falhou:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
