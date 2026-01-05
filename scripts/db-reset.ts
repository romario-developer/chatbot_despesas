import { prisma } from "../src/db/prisma";

async function main() {
  if (process.env.NODE_ENV === "production" && process.env.RESET_CONFIRM !== "YES") {
    throw new Error('RESET_CONFIRM="YES" é obrigatório em produção para rodar reset.');
  }

  const counts = await Promise.all([
    prisma.expenseDraft.count(),
    prisma.expense.count(),
    prisma.planning.count(),
    prisma.userSession.count(),
    prisma.telegramLinkCode.count(),
    prisma.category.count(),
    prisma.user.count(),
  ]);

  console.log("[reset] contagens atuais:", {
    expenseDrafts: counts[0],
    expenses: counts[1],
    planning: counts[2],
    userSessions: counts[3],
    telegramLinkCodes: counts[4],
    categories: counts[5],
    users: counts[6],
  });

  await prisma.$transaction([
    prisma.expenseDraft.deleteMany(),
    prisma.expense.deleteMany(),
    prisma.planning.deleteMany(),
    prisma.userSession.deleteMany(),
    prisma.telegramLinkCode.deleteMany(),
    prisma.category.deleteMany(),
    prisma.user.deleteMany(),
  ]);

  console.log("[reset] concluído. Dados transacionais apagados, estrutura intacta.");
}

main()
  .catch((err) => {
    console.error("[reset] falhou:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
