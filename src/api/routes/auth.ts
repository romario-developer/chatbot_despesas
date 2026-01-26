import { Router } from 'express';
import jwt from 'jsonwebtoken';

import { prisma } from '../../db/prisma';
import { getAdminUser } from '../../services/userService';
import { ADMIN_TELEGRAM_ID } from '../../utils/systemUsers';
import { normalizeEmail } from '../../utils/email';
import { hashPassword, verifyPassword } from '../../utils/password';

const router = Router();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;

if (!ADMIN_PASSWORD) {
  throw new Error('Defina ADMIN_PASSWORD nas variaveis de ambiente');
}

if (!JWT_SECRET) {
  throw new Error('Defina JWT_SECRET nas variaveis de ambiente');
}
const JWT_SECRET_VALUE: string = JWT_SECRET;
const TOKEN_EXPIRY = '7d';

function signToken(subject: string) {
  return jwt.sign({ sub: subject }, JWT_SECRET_VALUE, { expiresIn: TOKEN_EXPIRY });
}

function buildUserPayload(user: { id: number; email: string | null; name?: string | null }) {
  return {
    id: user.id,
    email: user.email ?? undefined,
    name: user.name ?? undefined,
  };
}

router.post('/signup', async (req, res) => {
  const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  if (!rawEmail) {
    return res.status(400).json({ error: 'Email obrigatorio' });
  }
  const normalizedEmail = normalizeEmail(rawEmail);
  if (!normalizedEmail) {
    return res.status(400).json({ error: 'Email invalido' });
  }

  if (typeof req.body?.password !== 'string') {
    return res.status(400).json({ error: 'Senha obrigatoria' });
  }
  const rawPassword = req.body.password.trim();
  if (rawPassword.length < 8) {
    return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });
  }

  const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const name = rawName ? rawName.slice(0, 120) : undefined;

  const existing = await prisma.user.findFirst({
    where: {
      OR: [{ email: normalizedEmail }, { telegramId: normalizedEmail }],
    },
    select: { id: true },
  });
  if (existing) {
    return res.status(409).json({ error: 'Email ja cadastrado' });
  }

  try {
    const passwordHash = hashPassword(rawPassword);
    const created = await prisma.user.create({
      data: {
        email: normalizedEmail,
        name: name ?? undefined,
        passwordHash,
        mustChangePassword: false,
      },
    });
    return res.status(201).json({
      token: signToken(normalizedEmail),
      user: buildUserPayload(created),
    });
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'P2002'
    ) {
      return res.status(409).json({ error: 'Email ja cadastrado' });
    }
    console.error('[auth][signup] erro:', err);
    return res.status(500).json({ error: 'Nao foi possivel criar o usuario' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};

  if (typeof password !== 'string' || !password.length) {
    return res.status(400).json({ error: 'Senha obrigatoria' });
  }

  const rawEmail = typeof email === 'string' ? email.trim() : '';
  if (typeof email !== 'undefined' && email !== null && typeof email !== 'string') {
    return res.status(400).json({ error: 'Email invalido' });
  }

  const normalizedEmail = rawEmail ? normalizeEmail(rawEmail) : null;
  if (rawEmail && !normalizedEmail) {
    return res.status(400).json({ error: 'Email invalido' });
  }

  if (normalizedEmail) {
    const user = await prisma.user.findFirst({
      where: { email: normalizedEmail },
      select: { id: true, telegramId: true, email: true, name: true, passwordHash: true },
    });

    if (!user?.passwordHash || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Credenciais invalidas' });
    }

    const subject = user.telegramId ?? user.email;
    if (!subject) {
      return res.status(500).json({ error: 'Usuario sem identificador' });
    }
    return res.json({ token: signToken(subject), user: buildUserPayload(user) });
  }

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Credenciais invalidas' });
  }

  const adminUser = await getAdminUser();
  return res.json({
    token: signToken(ADMIN_TELEGRAM_ID),
    user: buildUserPayload(adminUser),
  });
});

export default router;
