import { Router } from 'express';
import jwt from 'jsonwebtoken';

import { prisma } from '../../db/prisma';
import { normalizeEmail } from '../../utils/email';
import { verifyPassword } from '../../utils/password';
import { getAdminUser } from '../../services/userService';

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
      select: { telegramId: true, passwordHash: true, mustChangePassword: true },
    });

    if (!user?.passwordHash || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Credenciais invalidas' });
    }

    const token = jwt.sign({ sub: user.telegramId }, JWT_SECRET_VALUE, { expiresIn: '7d' });
    return res.json({ token, mustChangePassword: user.mustChangePassword });
  }

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Credenciais invalidas' });
  }

  const token = jwt.sign({ sub: 'admin' }, JWT_SECRET_VALUE, { expiresIn: '7d' });
  const adminUser = await getAdminUser();
  return res.json({ token, mustChangePassword: adminUser.mustChangePassword });
});

export default router;
