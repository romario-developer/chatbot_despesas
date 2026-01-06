import { prisma } from "../src/db/prisma";
import { ADMIN_TELEGRAM_ID } from "../src/utils/systemUsers";
import { getMonthRangeTZ } from "../src/utils/dateRange";
import { TZ } from "../src/utils/dates";

async function getAdminUser() {
  const existing = await prisma.user.findFirst({
    where: { OR: [{ telegramId: ADMIN_TELEGRAM_ID }, { telegramChatId: ADMIN_TELEGRAM_ID }] },
  });
  if (existing) return existing;
  return prisma.user.create({ data: { telegramId: ADMIN_TELEGRAM_ID } });
}

async function main() {
  const adminUser = await getAdminUser();
  const { start, endExclusive } = getMonthRangeTZ(new Date(), TZ);

  const filter = {
    userId: { not: adminUser.id },
    source: { startsWith: "telegram" },
    date: { gte: start, lt: endExclusive },
  } as const;

  const pending = await prisma.expense.count({ where: filter });
  console.log(
    `[migrate-telegram-admin] despesas telegram fora do admin para ${start.toISOString()}-${endExclusive.toISOString()}: ${pending}`,
  );

  if (!pending) {
    console.log("[migrate-telegram-admin] nada a migrar.");
    return;
  }

  const updated = await prisma.expense.updateMany({
    where: filter,
    data: { userId: adminUser.id },
  });

  console.log(
    `[migrate-telegram-admin] migradas ${updated.count} despesas para userId=${adminUser.id} (telegramId=${ADMIN_TELEGRAM_ID})`,
  );
}

main()
  .catch((err) => {
    console.error("[migrate-telegram-admin] falhou:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
