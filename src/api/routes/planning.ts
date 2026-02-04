import { randomUUID } from 'crypto';
import { Router } from 'express';

import { AuthedRequest } from '../middleware/auth';
import {
  DEFAULT_PLANNING,
  PlanningData,
  PLANNING_FORMAT_VERSION,
  getPlanningByUserId,
  upsertPlanning,
} from '../../services/planningService';
import { toCentsBRL } from '../../utils/money';

const router = Router();

function ensureNonNegativeCents(value: unknown): number {
  const cents = toCentsBRL(value);
  if (cents === null || cents < 0) return 0;
  return cents;
}

function generateId() {
  if (typeof randomUUID === 'function') return randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizePlanning(input: any): PlanningData {
  const normalized: PlanningData = {
    salaryByMonth: {},
    extrasByMonth: {},
    fixedBills: [],
    formatVersion: PLANNING_FORMAT_VERSION,
  };

  if (input && typeof input === 'object' && input.salaryByMonth && typeof input.salaryByMonth === 'object') {
    for (const [key, value] of Object.entries(input.salaryByMonth as Record<string, unknown>)) {
      if (typeof key !== 'string') continue;
      normalized.salaryByMonth[key] = ensureNonNegativeCents(value);
    }
  }

  if (input && typeof input === 'object' && input.extrasByMonth && typeof input.extrasByMonth === 'object') {
    for (const [monthKey, extrasValue] of Object.entries(
      input.extrasByMonth as Record<string, unknown>,
    )) {
      if (typeof monthKey !== 'string') continue;
      const items = Array.isArray(extrasValue) ? extrasValue : [];
      const normalizedItems: { id: string; label?: string; amount: number }[] = [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const id =
          typeof (item as any).id === 'string' && (item as any).id.trim()
            ? (item as any).id
            : generateId();
        const label = typeof (item as any).label === 'string' ? (item as any).label : undefined;
        const amount = ensureNonNegativeCents((item as any).amount);
        normalizedItems.push({ id, label, amount });
      }
      normalized.extrasByMonth[monthKey] = normalizedItems;
    }
  }

  if (input && typeof input === 'object' && Array.isArray(input.fixedBills)) {
    const bills: { id: string; label?: string; amount: number }[] = [];
    for (const item of input.fixedBills as any[]) {
      if (!item || typeof item !== 'object') continue;
      const id = typeof (item as any).id === 'string' && (item as any).id.trim() ? (item as any).id : generateId();
      const label = typeof (item as any).label === 'string' ? (item as any).label : undefined;
      const amount = ensureNonNegativeCents((item as any).amount);
      bills.push({ id, label, amount });
    }
    normalized.fixedBills = bills;
  }

  return normalized;
}

router.get('/', async (req: AuthedRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const planning = await getPlanningByUserId(req.user.id);
  return res.json(planning ?? DEFAULT_PLANNING);
});

router.put('/', async (req: AuthedRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const normalized = normalizePlanning(req.body ?? {});
  const saved = await upsertPlanning(req.user.id, normalized);
  return res.json(saved ?? DEFAULT_PLANNING);
});

export default router;
