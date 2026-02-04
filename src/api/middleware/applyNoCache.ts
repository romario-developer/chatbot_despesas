import type { NextFunction, Request, Response } from 'express';

const NO_CACHE_HEADER_VALUE = 'no-store, no-cache, must-revalidate, proxy-revalidate';

export function applyNoCache(req: Request, res: Response, next: NextFunction) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    res.setHeader('Cache-Control', NO_CACHE_HEADER_VALUE);
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
}
