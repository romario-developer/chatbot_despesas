export type DbState = {
  ready: boolean;
  lastError: string | null;
  lastOkAt: string | null;
};

export const dbState: DbState = {
  ready: false,
  lastError: null,
  lastOkAt: null,
};

export function markDbReady() {
  dbState.ready = true;
  dbState.lastError = null;
  dbState.lastOkAt = new Date().toISOString();
}

export function markDbError(error: Error | string | null) {
  dbState.ready = false;
  dbState.lastError = typeof error === 'string' ? error : error?.message ?? null;
}
