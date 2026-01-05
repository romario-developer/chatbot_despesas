import "dotenv/config";

import { prisma } from "../src/db/prisma";
import { getOrCreateUser } from "../src/services/userService";
import { normalizeCategoryName } from "../src/utils/normalize";
import { API_TELEGRAM_ID } from "../src/utils/systemUsers";

async function resolveUserByTelegram(telegramId: string) {
  return prisma.user.findFirst({
    where: { OR: [{ telegramId }, { telegramChatId: telegramId }] },
  });
}

async function main() {
  const oldTelegramId = process.env.OLD_TELEGRAM_ID || "admin";
  const newTelegramId = process.env.NEW_TELEGRAM_ID || API_TELEGRAM_ID;

  const oldUser = await resolveUserByTelegram(oldTelegramId);
  if (!oldUser) {
    console.error("[migrate] Old user not found for telegramId:", oldTelegramId);
    process.exit(1);
  }

  const newUser = await getOrCreateUser(newTelegramId);

  if (oldUser.id === newUser.id) {
    console.log("[migrate] Old and new users are the same. Nothing to do.");
    return;
  }

  console.log("[migrate] Moving data from user", oldUser.id, "->", newUser.id);

  const oldCategories = await prisma.category.findMany({ where: { userId: oldUser.id } });
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
    }

    categoryMap.set(cat.id, targetId);
  }

  // Move expenses
  for (const [oldCatId, newCatId] of categoryMap.entries()) {
    const updated = await prisma.expense.updateMany({
      where: { userId: oldUser.id, categoryId: oldCatId },
      data: { userId: newUser.id, categoryId: newCatId },
    });
    if (updated.count) {
      console.log(
        `[migrate] Moved ${updated.count} expenses from category ${oldCatId} -> ${newCatId}`,
      );
    }
  }

  // Move drafts
  for (const [oldCatId, newCatId] of categoryMap.entries()) {
    const updated = await prisma.expenseDraft.updateMany({
      where: { userId: oldUser.id, categoryId: oldCatId },
      data: { userId: newUser.id, categoryId: newCatId },
    });
    if (updated.count) {
      console.log(
        `[migrate] Moved ${updated.count} drafts from category ${oldCatId} -> ${newCatId}`,
      );
    }
  }

  // Planning
  const oldPlanning = await prisma.planning.findUnique({ where: { userId: oldUser.id } });
  const newPlanning = await prisma.planning.findUnique({ where: { userId: newUser.id } });
  if (oldPlanning && !newPlanning) {
    await prisma.planning.update({
      where: { userId: oldUser.id },
      data: { userId: newUser.id },
    });
    console.log("[migrate] Moved planning to user", newUser.id);
  }

  // UserSession
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
    console.log("[migrate] Moved user session.");
  }

  console.log("[migrate] Done.");
}

main()
  .catch((err) => {
    console.error("[migrate] Failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
