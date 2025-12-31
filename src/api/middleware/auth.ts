import jwt, { JwtPayload } from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';

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
}

export function authMiddleware(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = header.replace('Bearer ', '').trim();
  try {
    const payload = jwt.verify(token, JWT_SECRET_VALUE) as JwtPayload;
    req.auth = { sub: typeof payload.sub === 'string' ? payload.sub : 'admin' };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}
