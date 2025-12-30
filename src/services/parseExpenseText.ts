import { amountStringToCents } from '../utils/money';
import { nowBahia, parseDateFromText, TZ, dayjs } from '../utils/dates';

export interface ParsedExpense {
  amountCents: number;
  description: string;
  categoryName: string;
  date: Date;
  rawText: string;
  confidence: 'high' | 'medium' | 'low';
  issues: string[];
}

const inferenceRules: { keywords: string[]; category: string }[] = [
  { keywords: ['diesel', 'gasolina', 'combust', 'combustível'], category: 'Combustível' },
  { keywords: ['mercado', 'supermercado'], category: 'Alimentação' },
  { keywords: ['funcionário', 'funcionario', 'diária', 'diaria', 'pagamento'], category: 'Funcionários' },
  { keywords: ['ração', 'racao', 'vacina', 'animal'], category: 'Animais' },
  { keywords: ['energia', 'luz', 'água', 'agua', 'internet'], category: 'Contas' },
];

export function parseExpenseText(text: string): ParsedExpense {
  const rawText = text.trim();
  if (!rawText) {
    throw new Error('Informe um texto com o gasto.');
  }

  const amountMatch = rawText.match(/(?:r\$?\s*)?-?\d{1,3}(?:[\.\s]\d{3})*(?:[.,]\d{1,2})|-?\d+(?:[.,]\d{1,2})?/i);
  if (!amountMatch) {
    throw new Error('Não encontrei o valor. Reenvie incluindo o valor, ex: "mercado 128,90".');
  }

  const amountCents = amountStringToCents(amountMatch[0]);
  if (amountCents === null) {
    throw new Error('Não consegui entender o valor. Tente usar formato "35" ou "35,50".');
  }

  let workingText = rawText.replace(amountMatch[0], ' ');

  const dateInfo = parseDateFromText(workingText);
  if (dateInfo?.matchedText) {
    workingText = workingText.replace(dateInfo.matchedText, ' ');
  }
  const date = (dateInfo?.date
    ? dayjs(dateInfo.date)
    : nowBahia()
  )
    .tz(TZ)
    .startOf('day')
    .toDate();

  let categoryName = 'Outros';
  const categoryMatch = workingText.match(/categoria\s+([a-zA-ZÀ-ÿ0-9\s]+)/i);
  if (categoryMatch) {
    categoryName = categoryMatch[1].trim() || 'Outros';
    workingText = workingText.replace(categoryMatch[0], ' ');
  } else {
    const lower = workingText.toLowerCase();
    const inferred = inferenceRules.find((rule) =>
      rule.keywords.some((word) => lower.includes(word)),
    );
    if (inferred) {
      categoryName = inferred.category;
    }
  }

  const description = workingText.replace(/\s+/g, ' ').trim() || 'Sem descrição';

  const issues: string[] = [];
  if (!description || description === 'Sem descrição') issues.push('missing_description');
  if (categoryName.toLowerCase() === 'outros') issues.push('ambiguous_category');

  let confidence: ParsedExpense['confidence'] = 'high';
  if (issues.length === 1) confidence = 'medium';
  if (issues.length >= 2) confidence = 'low';

  return { amountCents, description, categoryName, date, rawText, confidence, issues };
}
