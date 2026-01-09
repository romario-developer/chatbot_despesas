export type InferredCategory = {
  categoryId?: string;
  categoryName?: string;
  confidence: number;
};

type CategoryRule = {
  name: string;
  keywords: string[];
};

const CATEGORY_RULES: CategoryRule[] = [
  {
    name: 'Alimenta\u00e7\u00e3o',
    keywords: [
      'mercado',
      'supermercado',
      'feira',
      'acougue',
      'padaria',
      'lanche',
      'almoco',
      'janta',
      'pizza',
      'hamburguer',
      'ifood',
      'delivery',
    ],
  },
  {
    name: 'Sa\u00fade/Bem estar',
    keywords: [
      'remedio',
      'farmacia',
      'consulta',
      'exame',
      'medico',
      'medica',
      'dentista',
      'vitamina',
    ],
  },
  {
    name: 'Pets/Animais',
    keywords: ['racao', 'pet', 'veterinario', 'veterinaria', 'banho', 'tosa'],
  },
  {
    name: 'Transporte',
    keywords: ['gasolina', 'combustivel', 'uber', '99', 'onibus', 'passagem', 'estacionamento'],
  },
  {
    name: 'Casa',
    keywords: ['aluguel', 'energia', 'luz', 'agua', 'internet', 'gas', 'condominio'],
  },
];

function normalizeText(text: string) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countMatches(text: string, keywords: string[]) {
  return keywords.reduce((count, keyword) => {
    const pattern = new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'i');
    return pattern.test(text) ? count + 1 : count;
  }, 0);
}

function computeConfidence(matchCount: number) {
  if (matchCount <= 0) return 0;
  return Math.min(0.9, 0.5 + matchCount * 0.1);
}

export function inferCategory(description: string): InferredCategory {
  const normalized = normalizeText(description);
  if (!normalized) {
    return { confidence: 0 };
  }

  let bestRule: CategoryRule | null = null;
  let bestMatches = 0;

  for (const rule of CATEGORY_RULES) {
    const matches = countMatches(normalized, rule.keywords);
    if (matches > bestMatches) {
      bestMatches = matches;
      bestRule = rule;
    }
  }

  if (!bestRule || bestMatches === 0) {
    return { confidence: 0 };
  }

  return {
    categoryName: bestRule.name,
    confidence: computeConfidence(bestMatches),
  };
}
