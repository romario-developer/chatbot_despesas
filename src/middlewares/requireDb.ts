import type { RequestHandler } from 'express';

import { dbState } from '../infra/db/dbState';

const requireDb: RequestHandler = (_req, res, next) => {
  if (!dbState.ready) {
    return res.status(503).json({
      error: 'DB_UNAVAILABLE',
      message: 'Banco indisponível no momento. Tente novamente em instantes.',
    });
  }
  return next();
};

export default requireDb;
