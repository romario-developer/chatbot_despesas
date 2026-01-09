import { normalizeCategoryName } from './normalize';

const CATEGORY_PALETTE = [
  '#5B8FF9',
  '#61DDAA',
  '#65789B',
  '#F6BD16',
  '#7262FD',
  '#78D3F8',
  '#9661BC',
  '#F6903D',
  '#008685',
  '#F08BB4',
  '#0A1D56',
  '#F2637B',
];

function normalizeForHash(value: string) {
  return normalizeCategoryName(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function hashString(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function getCategoryColor(name: string) {
  const normalized = normalizeForHash(name);
  if (!normalized) return CATEGORY_PALETTE[0];
  const index = hashString(normalized) % CATEGORY_PALETTE.length;
  return CATEGORY_PALETTE[index];
}
