import { Prisma } from '@prisma/client';

import { prisma } from '../infra/db/prisma';

const EXPORT_VERSION = 1;

export type UserBackupMeta = {
  userId: number;
  generatedAt: string;
  appEnv: string;
  version: number;
};

export type UserBackupData = {
  user: {
    id: number;
    telegramId: string | null;
    telegramChatId: string | null;
    email: string | null;
    name: string | null;
    mustChangePassword: boolean;
    createdAt: string;
  };
  categories: Prisma.CategoryGetPayload<{}>[];
  cards: Prisma.CardGetPayload<{}>[];
  installmentGroups: Prisma.InstallmentGroupGetPayload<{}>[];
  cardPayments: Prisma.CardPaymentGetPayload<{}>[];
  expenses: Prisma.ExpenseGetPayload<{}>[];
  expenseDrafts: Prisma.ExpenseDraftGetPayload<{}>[];
  planning: Prisma.PlanningGetPayload<{}>[];
  userSession: Prisma.UserSessionGetPayload<{}> | null;
  telegramLinkCodes: Prisma.TelegramLinkCodeGetPayload<{}>[];
  credits: Prisma.CreditGetPayload<{}>[];
};

export type UserBackupSnapshot = {
  meta: UserBackupMeta;
  data: UserBackupData;
};

export async function buildUserBackup(userId: number, appEnv: string): Promise<UserBackupSnapshot> {
  const [
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
  ] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        telegramId: true,
        telegramChatId: true,
        email: true,
        name: true,
        mustChangePassword: true,
        createdAt: true,
      },
    }),
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
    throw new Error('Usuário não encontrado');
  }

  return {
    meta: {
      userId,
      generatedAt: new Date().toISOString(),
      appEnv,
      version: EXPORT_VERSION,
    },
    data: {
      user: {
        ...user,
        createdAt: user.createdAt.toISOString(),
      },
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

type Counts = Record<string, number>;

const INTEGER_TABLES = ['Category', 'Card', 'CardPayment', 'Expense', 'Planning', 'UserSession', 'Credit'];

export async function restoreUserBackup(userId: number, data: UserBackupData) {
  const sanitizedCategories = data.categories.map((item) => ({ ...item, userId }));
  const sanitizedCards = data.cards.map((item) => ({ ...item, userId }));
  const sanitizedInstallments = data.installmentGroups.map((item) => ({ ...item, userId }));
  const sanitizedCardPayments = data.cardPayments.map((item) => ({ ...item, userId }));
  const sanitizedExpenses = data.expenses.map((item) => ({ ...item, userId }));
  const sanitizedDrafts = data.expenseDrafts.map((item) => ({ ...item, userId }));
  const sanitizedPlanning = data.planning.map((item) => ({
    ...item,
    userId,
    data: item.data as Prisma.InputJsonValue,
  }));
  const sanitizedSession = data.userSession ? { ...data.userSession, userId } : null;
  const sanitizedTelegramCodes = data.telegramLinkCodes.map((item) => ({ ...item, userId }));
  const sanitizedCredits = data.credits.map((item) => ({ ...item, userId }));

  return prisma.$transaction(async (tx) => {
    await tx.expense.deleteMany({ where: { userId } });
    await tx.expenseDraft.deleteMany({ where: { userId } });
    await tx.cardPayment.deleteMany({ where: { userId } });
    await tx.installmentGroup.deleteMany({ where: { userId } });
    await tx.planning.deleteMany({ where: { userId } });
    await tx.userSession.deleteMany({ where: { userId } });
    await tx.telegramLinkCode.deleteMany({ where: { userId } });
    await tx.credit.deleteMany({ where: { userId } });
    await tx.card.deleteMany({ where: { userId } });
    await tx.category.deleteMany({ where: { userId } });

    if (sanitizedCategories.length) {
      await tx.category.createMany({ data: sanitizedCategories });
      await resetSequence(tx, 'Category');
    }
    if (sanitizedCards.length) {
      await tx.card.createMany({ data: sanitizedCards });
      await resetSequence(tx, 'Card');
    }
    if (sanitizedInstallments.length) {
      await tx.installmentGroup.createMany({ data: sanitizedInstallments });
    }
    if (sanitizedCardPayments.length) {
      await tx.cardPayment.createMany({ data: sanitizedCardPayments });
      await resetSequence(tx, 'CardPayment');
    }
    if (sanitizedExpenses.length) {
      await tx.expense.createMany({ data: sanitizedExpenses });
      await resetSequence(tx, 'Expense');
    }
    if (sanitizedDrafts.length) {
      await tx.expenseDraft.createMany({ data: sanitizedDrafts });
    }
    if (sanitizedPlanning.length) {
      await tx.planning.createMany({ data: sanitizedPlanning });
      await resetSequence(tx, 'Planning');
    }
    if (sanitizedSession) {
      await tx.userSession.create({ data: sanitizedSession });
      await resetSequence(tx, 'UserSession');
    }
    if (sanitizedTelegramCodes.length) {
      await tx.telegramLinkCode.createMany({ data: sanitizedTelegramCodes });
    }
    if (sanitizedCredits.length) {
      await tx.credit.createMany({ data: sanitizedCredits });
      await resetSequence(tx, 'Credit');
    }

    const counts: Counts = {
      categories: sanitizedCategories.length,
      cards: sanitizedCards.length,
      installmentGroups: sanitizedInstallments.length,
      cardPayments: sanitizedCardPayments.length,
      expenses: sanitizedExpenses.length,
      expenseDrafts: sanitizedDrafts.length,
      planning: sanitizedPlanning.length,
      userSession: sanitizedSession ? 1 : 0,
      telegramLinkCodes: sanitizedTelegramCodes.length,
      credits: sanitizedCredits.length,
    };

    return counts;
  });
}

async function resetSequence(tx: Prisma.TransactionClient, tableName: string) {
  await tx.$executeRawUnsafe(
    `SELECT setval(pg_get_serial_sequence('"${tableName}"','id'), COALESCE((SELECT MAX(id) FROM "${tableName}"), 0), true)`,
  );
}
