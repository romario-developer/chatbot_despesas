import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import { ApiError } from '../../errors/ApiError';

export function formatZodValidationMessage(error: ZodError) {
  const issues = error.errors.map((issue) => {
    const path = issue.path.length ? issue.path.join('.') : 'value';
    return `${path} ${issue.message}`;
  });
  return issues.join('; ');
}

function handleCorsError(err: Error, res: Response) {
  if (err.message === 'Not allowed by CORS') {
    res.status(403).json({ error: 'Origin not allowed', code: 'CORS_ERROR' });
    return true;
  }
  return false;
}

export default function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: formatZodValidationMessage(err) || 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: err.errors,
    });
    return;
  }

  if (err instanceof ApiError) {
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      details: err.details,
    });
    return;
  }

  if (err instanceof Error && handleCorsError(err, res)) {
    return;
  }

  console.error('[ERROR_HANDLER]', req.method, req.originalUrl, err);
  res.status(500).json({ error: 'Internal Server Error', code: 'UNHANDLED_ERROR' });
}
