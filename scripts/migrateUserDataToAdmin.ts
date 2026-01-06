import { prisma } from "../src/db/prisma";
import { normalizeCategoryName } from "../src/utils/normalize";
import { getAdminUser } from "../src/services/userService";

async function migrateUser(fromUserId: number, adminUserId: number) {
  if (fromUserId === adminUserId) {
    console.log("[migrate-to-admin] fromUserId ja e o admin, nada a fazer.");
    return;
  }

  console.log("[migrate-to-admin] preparando categorias...");
  const oldCategories = await prisma.category.findMany({ where: { userId: fromUserId } });
  const categoryMap = new Map<number, number>();

  for (const cat of oldCategories) {
    const normalized = cat.normalizedName || normalizeCategoryName(cat.name);
    const existing = await prisma.category.findFirst({
      where: { userId: adminUserId, normalizedName: normalized },
    });

    let targetId = existing?.id;
    if (!targetId) {
      const created = await prisma.category.create({
        data: { userId: adminUserId, name: cat.name, normalizedName: normalized },
      });
      targetId = created.id;
      console.log("[migrate-to-admin] categoria criada", { name: cat.name, id: targetId });
    }

    categoryMap.set(cat.id, targetId);
  }

  console.log("[migrate-to-admin] movendo despesas...");
  for (const [oldCatId, newCatId] of categoryMap.entries()) {
    const updated = await prisma.expense.updateMany({
      where: { userId: fromUserId, categoryId: oldCatId },
      data: { userId: adminUserId, categoryId: newCatId },
    });
    if (updated.count) {
      console.log(`[migrate-to-admin] despesas movidas para cat ${newCatId}: ${updated.count}`);
    }
  }

  console.log("[migrate-to-admin] movendo rascunhos...");
  for (const [oldCatId, newCatId] of categoryMap.entries()) {
    const updated = await prisma.expenseDraft.updateMany({
      where: { userId: fromUserId, categoryId: oldCatId },
      data: { userId: adminUserId, categoryId: newCatId },
    });
    if (updated.count) {
      console.log(`[migrate-to-admin] drafts movidos para cat ${newCatId}: ${updated.count}`);
    }
  }

  console.log("[migrate-to-admin] movendo planning...");
  const oldPlanning = await prisma.planning.findUnique({ where: { userId: fromUserId } });
  const adminPlanning = await prisma.planning.findUnique({ where: { userId: adminUserId } });
  if (oldPlanning) {
    if (adminPlanning) {
      const oldData = typeof oldPlanning.data === "object" && oldPlanning.data ? (oldPlanning.data as any) : {};
      const newData = typeof adminPlanning.data === "object" && adminPlanning.data ? (adminPlanning.data as any) : {};
      await prisma.planning.update({
        where: { id: adminPlanning.id },
        data: { data: { ...oldData, ...newData } },
      });
      await prisma.planning.delete({ where: { userId: fromUserId } }).catch(() => {});
      console.log("[migrate-to-admin] planning mesclado no admin");
    } else {
      await prisma.planning.update({
        where: { userId: fromUserId },
        data: { userId: adminUserId },
      });
      console.log("[migrate-to-admin] planning transferido para admin");
    }
  }

  console.log("[migrate-to-admin] movendo sessoes e links...");
  const oldSession = await prisma.userSession.findUnique({ where: { userId: fromUserId } });
  if (oldSession) {
    await prisma.userSession.upsert({
      where: { userId: adminUserId },
      create: {
        userId: adminUserId,
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
    await prisma.userSession.delete({ where: { userId: fromUserId } }).catch(() => {});
  }

  await prisma.telegramLinkCode.updateMany({
    where: { userId: fromUserId },
    data: { userId: adminUserId },
  });

  console.log("[migrate-to-admin] concluido.");
}

async function main() {
  const arg = process.argv.find((a) => a.startsWith("--from="));
  if (!arg) {
    throw new Error('Uso: tsx scripts/migrateUserDataToAdmin.ts --from=<oldUserId>');
  }
  const fromUserId = Number(arg.split("=", 2)[1]);
  if (!Number.isInteger(fromUserId) || fromUserId <= 0) {
    throw new Error('"from" deve ser inteiro > 0');
  }

  const adminUser = await getAdminUser();

  const before = await prisma.expense.count({ where: { userId: fromUserId } });
  console.log(`[migrate-to-admin] despesas do usuario ${fromUserId} antes: ${before}`);

  await migrateUser(fromUserId, adminUser.id);

  const after = await prisma.expense.count({ where: { userId: fromUserId } });
  const adminTotal = await prisma.expense.count({ where: { userId: adminUser.id } });
  console.log(`[migrate-to-admin] despesas restantes do usuario ${fromUserId}: ${after}`);
  console.log(`[migrate-to-admin] despesas agora no admin (${adminUser.id}): ${adminTotal}`);
}

main()
  .catch((err) => {
    console.error("[migrate-to-admin] falhou:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
