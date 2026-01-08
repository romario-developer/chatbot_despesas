import {
  parseQuickEntryText,
  type CategoryResolver,
  type ParsedQuickEntry,
} from '../domain/quickEntry/parseQuickEntry';

export type ParsedExpense = ParsedQuickEntry;

const inferenceRules: { keywords: string[]; category: string }[] = [
  { keywords: ['diesel', 'gasolina', 'combust', 'combust¡vel'], category: 'Combust¡vel' },
  { keywords: ['mercado', 'supermercado'], category: 'Alimenta‡Æo' },
  { keywords: ['funcion rio', 'funcionario', 'di ria', 'diaria', 'pagamento'], category: 'Funcion rios' },
  { keywords: ['ra‡Æo', 'racao', 'vacina', 'animal'], category: 'Animais' },
  { keywords: ['energia', 'luz', ' gua', 'agua', 'internet'], category: 'Contas' },
];

export function parseExpenseText(text: string): ParsedExpense {
  const categoryResolver: CategoryResolver = (workingText: string) => {
    let categoryName = 'Outros';
    let cleanedText = workingText;

    const categoryMatch = cleanedText.match(/categoria\s+([a-zA-Z·-˜0-9\s]+)/i);
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

  return parseQuickEntryText(text, {
    amountMatchStrategy: 'first',
    categoryResolver,
    defaultCategoryName: 'Outros',
    defaultDescription: 'Sem descri‡Æo',
    messages: {
      emptyText: 'Informe um texto com o gasto.',
      missingAmount: 'NÆo encontrei o valor. Reenvie incluindo o valor, ex: "mercado 128,90".',
      invalidAmount: 'NÆo consegui entender o valor. Tente usar formato "35" ou "35,50".',
    },
  });
}
