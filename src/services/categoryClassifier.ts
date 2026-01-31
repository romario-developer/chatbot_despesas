import type { CategoryMemory } from '@prisma/client';

import { prisma } from '../infra/db/prisma';

const RULE_CACHE_TTL_MS = 5 * 60 * 1000;

type RuleCacheEntry = {
  expiresAt: number;
  items: CachedRule[];
};

type CachedRule = {
  id: number;
  categoryId: number;
  priority: number;
  keywords: string[];
};

const ruleCache = new Map<number, RuleCacheEntry>();

export type CategoryClassificationResult = {
  categoryId: number;
  source: 'MEMORY' | 'RULE';
  normalizedText: string;
  ruleId?: number;
  matchedKeywords?: string[];
};

export async function classifyCategoryByText(
  userId: number,
  text: string,
): Promise<CategoryClassificationResult | null> {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const memory = await findMemoryMatch(userId, normalized);
  if (memory) {
    return { categoryId: memory.categoryId, source: 'MEMORY', normalizedText: memory.normalizedText };
  }

  const rules = await loadActiveRules(userId);
  let best: { rule: CachedRule; matched: string[]; score: number } | null = null;

  for (const rule of rules) {
    if (!rule.keywords.length) continue;
    const matches = rule.keywords.filter((keyword) => normalized.includes(keyword));
    if (!matches.length) continue;
    const score = rule.priority * 100 + matches.length;
    if (!best || score > best.score) {
      best = { rule, matched: matches, score };
    }
  }

  if (!best) return null;
  return {
    categoryId: best.rule.categoryId,
    source: 'RULE',
    normalizedText: normalized,
    ruleId: best.rule.id,
    matchedKeywords: best.matched,
  };
}

export async function learnCategoryMemory(
  userId: number,
  text: string,
  categoryId: number,
): Promise<void> {
  const normalized = normalizeText(text);
  if (!normalized) return;

  const category = await prisma.category.findFirst({
    where: { id: categoryId, userId },
  });
  if (!category) return;

  const existing = await prisma.categoryMemory.findUnique({
    where: { normalizedText: normalized },
    include: { category: true },
  });
  if (existing && existing.category?.userId !== userId) {
    return;
  }

  await prisma.categoryMemory.upsert({
    where: { normalizedText: normalized },
    create: { normalizedText: normalized, categoryId },
    update: { categoryId },
  });
}

function buildMemoryCandidates(normalized: string) {
  const tokens = normalized.split(' ').filter(Boolean);
  const candidates = [normalized];
  if (tokens.length >= 1) {
    candidates.push(tokens[0]);
  }
  if (tokens.length >= 2) {
    candidates.push(`${tokens[0]} ${tokens[1]}`);
  }
  return Array.from(new Set(candidates));
}

async function findMemoryMatch(userId: number, normalized: string): Promise<CategoryMemory | null> {
  const candidates = buildMemoryCandidates(normalized);
  for (const candidate of candidates) {
    const memory = await prisma.categoryMemory.findFirst({
      where: { normalizedText: candidate, category: { userId } },
    });
    if (memory) {
      return memory;
    }
  }
  return null;
}

function normalizeText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseKeywords(raw: string) {
  return raw
    .split(/[;,]+/)
    .map((token) => normalizeText(token))
    .filter((token) => Boolean(token));
}

async function loadActiveRules(userId: number) {
  const cached = ruleCache.get(userId);
  const now = Date.now();
  if (cached && now < cached.expiresAt) {
    return cached.items;
  }
  const rules = await prisma.categoryRule.findMany({
    where: { isActive: true, category: { userId } },
    orderBy: [{ priority: 'desc' }],
  });
  const parsed = rules.map((rule) => ({
    id: rule.id,
    categoryId: rule.categoryId,
    priority: rule.priority,
    keywords: parseKeywords(rule.keywords),
  }));
  ruleCache.set(userId, { expiresAt: now + RULE_CACHE_TTL_MS, items: parsed });
  return parsed;
}
