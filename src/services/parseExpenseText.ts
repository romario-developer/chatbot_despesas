import {
  parseQuickEntryText,
  type CategoryResolver,
  type ParsedQuickEntry,
} from '../domain/quickEntry/parseQuickEntry';
import { parseInstallments } from '../domain/quickEntryInstallments';
import { parsePayment } from '../domain/quickEntryPayment';
import { DEFAULT_PAYMENT_METHOD } from '../utils/paymentMethod';

export type ParsedExpense = ParsedQuickEntry;

const inferenceRules: { keywords: string[]; category: string }[] = [
  { keywords: ['diesel', 'gasolina', 'combust', 'combust\u00edvel'], category: 'Combust\u00edvel' },
  { keywords: ['mercado', 'supermercado'], category: 'Alimenta\u00e7\u00e3o' },
  {
    keywords: ['funcion\u00e1rio', 'funcionario', 'di\u00e1ria', 'diaria', 'pagamento'],
    category: 'Funcion\u00e1rios',
  },
  { keywords: ['ra\u00e7\u00e3o', 'racao', 'vacina', 'animal'], category: 'Animais' },
  { keywords: ['energia', 'luz', '\u00e1gua', 'agua', 'internet'], category: 'Contas' },
];

export function parseExpenseText(text: string): ParsedExpense {
  const categoryResolver: CategoryResolver = (workingText: string) => {
    let categoryName = 'Outros';
    let cleanedText = workingText;

    const categoryMatch = cleanedText.match(/categoria\s+([a-zA-Z\u00c0-\u00ff0-9\s]+)/i);
    if (categoryMatch) {
      categoryName = categoryMatch[1].trim() || 'Outros';
      cleanedText = cleanedText.replace(categoryMatch[0], ' ');
    } else {
      const lower = cleanedText.toLowerCase();
      const inferred = inferenceRules.find((rule) =>
        rule.keywords.some((word) => lower.includes(word)),
      );
      if (inferred) {
        categoryName = inferred.category;
      }
    }

    return { categoryName, cleanedText };
  };

  const installmentInfo = parseInstallments(text);
  const paymentInfo = parsePayment(installmentInfo.cleanedText);
  const parsed = parseQuickEntryText(paymentInfo.cleanedText, {
    amountMatchStrategy: 'first',
    categoryResolver,
    defaultCategoryName: 'Outros',
    defaultDescription: 'Sem descri\u00e7\u00e3o',
    messages: {
      emptyText: 'Informe um texto com o gasto.',
      missingAmount: 'N\u00e3o encontrei o valor. Reenvie incluindo o valor, ex: "mercado 128,90".',
      invalidAmount: 'N\u00e3o consegui entender o valor. Tente usar formato "35" ou "35,50".',
    },
  });
  parsed.paymentMethod = paymentInfo.paymentMethod ?? DEFAULT_PAYMENT_METHOD;
  parsed.cardNameGuess = paymentInfo.cardNameGuess;
  parsed.rawText = text;
  parsed.installmentsTotal = installmentInfo.installmentsTotal ?? 1;
  return parsed;
}
