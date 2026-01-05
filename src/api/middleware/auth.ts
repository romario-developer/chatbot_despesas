import jwt, { JwtPayload } from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';

import { getOrCreateUser } from '../../services/userService';
import { API_TELEGRAM_ID } from '../../utils/systemUsers';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('Defina JWT_SECRET nas variaveis de ambiente');
}
const JWT_SECRET_VALUE: string = JWT_SECRET;

export interface AuthPayload {
  sub: string;
}

export interface AuthedRequest extends Request {
  auth?: AuthPayload;
  user?: {
    id: number;
    telegramId: string;
    telegramChatId?: string | null;
  };
}

export async function authMiddleware(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = header.replace('Bearer ', '').trim();
  try {
    const payload = jwt.verify(token, JWT_SECRET_VALUE) as JwtPayload;
    const sub = typeof payload.sub === 'string' ? payload.sub : null;
    if (!sub) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const telegramId = sub === 'admin' ? API_TELEGRAM_ID : sub;
    const user = await getOrCreateUser(telegramId);

    req.auth = { sub };
    req.user = { id: user.id, telegramId: user.telegramId, telegramChatId: user.telegramChatId };

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}
