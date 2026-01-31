import { prisma } from '../infra/db/prisma';

export type UserBackupSnapshot = {
  meta: {
    userId: number;
    generatedAt: string;
    appEnv: string;
  };
  data: {
    user: Awaited<ReturnType<typeof prisma.user.findUnique>>;
    categories: Awaited<ReturnType<typeof prisma.category.findMany>>;
    cards: Awaited<ReturnType<typeof prisma.card.findMany>>;
    installmentGroups: Awaited<ReturnType<typeof prisma.installmentGroup.findMany>>;
    cardPayments: Awaited<ReturnType<typeof prisma.cardPayment.findMany>>;
    expenses: Awaited<ReturnType<typeof prisma.expense.findMany>>;
    expenseDrafts: Awaited<ReturnType<typeof prisma.expenseDraft.findMany>>;
    planning: Awaited<ReturnType<typeof prisma.planning.findMany>>;
    userSession: Awaited<ReturnType<typeof prisma.userSession.findFirst>>;
    telegramLinkCodes: Awaited<ReturnType<typeof prisma.telegramLinkCode.findMany>>;
    credits: Awaited<ReturnType<typeof prisma.credit.findMany>>;
  };
};

export async function buildUserBackup(userId: number, appEnv: string): Promise<UserBackupSnapshot> {
  const [user, categories, cards, installmentGroups, cardPayments, expenses, expenseDrafts, planning, userSession, telegramLinkCodes, credits] =
    await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.category.findMany({ where: { userId } }),
      prisma.card.findMany({ where: { userId } }),
      prisma.installmentGroup.findMany({ where: { userId } }),
      prisma.cardPayment.findMany({ where: { userId } }),
      prisma.expense.findMany({ where: { userId } }),
      prisma.expenseDraft.findMany({ where: { userId } }),
      prisma.planning.findMany({ where: { userId } }),
      prisma.userSession.findFirst({ where: { userId } }),
      prisma.telegramLinkCode.findMany({ where: { userId } }),
      prisma.credit.findMany({ where: { userId } }),
    ]);

  if (!user) {
    throw new Error(`Usuário ${userId} não encontrado`);
  }

  return {
    meta: {
      userId,
      generatedAt: new Date().toISOString(),
      appEnv,
    },
    data: {
      user,
      categories,
      cards,
      installmentGroups,
      cardPayments,
      expenses,
      expenseDrafts,
      planning,
      userSession,
      telegramLinkCodes,
      credits,
    },
  };
}
