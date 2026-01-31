import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

import { ADMIN_TELEGRAM_ID } from '../src/utils/systemUsers';

const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim();
const ADMIN_NAME = process.env.ADMIN_NAME?.trim() || 'Admin';
const ADMIN_ROLE = process.env.ADMIN_ROLE?.trim() || 'admin';
const parsedRounds = Number.parseInt(process.env.BCRYPT_ROUNDS ?? '10', 10);
const BCRYPT_ROUNDS = Number.isFinite(parsedRounds) ? Math.max(parsedRounds, 1) : 10;
async function ensureAdmin() {
  if (!ADMIN_EMAIL) {
    throw new Error('Defina ADMIN_EMAIL no ambiente antes de rodar o seed.');
  }
  if (!ADMIN_PASSWORD) {
    throw new Error('Defina ADMIN_PASSWORD no ambiente antes de rodar o seed.');
  }

  const hashedPassword = bcrypt.hashSync(ADMIN_PASSWORD, BCRYPT_ROUNDS);

  const existing = await prisma.user.findFirst({
    where: {
      OR: [
        { email: ADMIN_EMAIL },
        { telegramId: ADMIN_TELEGRAM_ID },
        { telegramChatId: ADMIN_TELEGRAM_ID },
      ],
    },
  });

  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        email: ADMIN_EMAIL,
        name: ADMIN_NAME,
        passwordHash: hashedPassword,
        mustChangePassword: false,
        telegramId: ADMIN_TELEGRAM_ID,
        telegramChatId: ADMIN_TELEGRAM_ID,
      },
    });
    console.log('Admin já existe. Credenciais e meta atualizadas, papel:', ADMIN_ROLE);
    return;
  }

  await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      name: ADMIN_NAME,
      passwordHash: hashedPassword,
      mustChangePassword: false,
      telegramId: ADMIN_TELEGRAM_ID,
      telegramChatId: ADMIN_TELEGRAM_ID,
    },
  });

  console.log('Admin criado com sucesso (papel: %s).', ADMIN_ROLE);
}

async function main() {
  await ensureAdmin();
}

main()
  .catch((error) => {
    console.error('Erro ao rodar o seed de admin:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
