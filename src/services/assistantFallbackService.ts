import type { AssistantModelResponse } from './assistantChatService';
import { parseInstallmentPattern } from '../domain/installmentPattern';

const currencyFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

const undoKeywords = [
  'desfaz',
  'desfazer',
  'cancelar ultimo',
  'cancelar o último',
  'cancelar o ultimo',
  'apagar ultimo',
  'apagar o último',
  'apagar o ultimo',
];

const updatePrefixes = ['na verdade', 'corrige', 'corrija', 'ajusta', 'errei', 'foi', 'foi no', 'foi no cartão'];
const queryKeywords = ['quanto gastei', 'total do mes', 'resumo', 'balanco', 'saldo do mes', 'gastos do mes'];
const incomeKeywords = ['recebi', 'entrada', 'salario', 'pix recebido', 'ganhei'];

const PIX_KEYWORD_REGEX = /\bpix\b/;

const PAYMENT_DESCRIPTION_PATTERNS = [
  'paguei via pix',
  'paguei no pix',
  'paguei via',
  'paguei no',
  'paguei na',
  'paguei',
  'gastei no',
  'gastei na',
  'gastei',
  'pix',
  'via pix',
  'no pix',
];

const DESCRIPTION_CONNECTORS = [
  'com',
  'com o',
  'com a',
  'pelo',
  'pela',
  'pelos',
  'pelas',
  'nos',
  'nas',
  'no',
  'na',
  'de',
  'do',
  'da',
  'em',
  'por',
  'via',
  'no pix',
  'na conta',
  'no cartao',
  'no cartão',
];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removePatterns(text: string, patterns: string[]) {
  return patterns.reduce((current, pattern) => {
    const regex = new RegExp(`\\b${escapeRegExp(pattern)}\\b`, 'gi');
    return current.replace(regex, ' ');
  }, text);
}

function containsPix(text: string) {
  PIX_KEYWORD_REGEX.lastIndex = 0;
  return PIX_KEYWORD_REGEX.test(text);
}

const categoryHints: Array<{ name: string; keywords: string[] }> = [
  {
    name: 'Alimentação',
    keywords: ['mercado', 'supermercado', 'padaria', 'almoço', 'jantar', 'ifood', 'açougue', 'lanche'],
  },
  {
    name: 'Transporte',
    keywords: ['posto', 'gasolina', 'combustivel', 'uber', '99', 'onibus', 'busao'],
  },
  { name: 'Saúde', keywords: ['farmacia', 'remedio', 'consulta', 'exame'] },
  { name: 'Casa', keywords: ['energia', 'luz', 'agua', 'agua', 'internet', 'aluguel', 'fixa'] },
  { name: 'Serviços', keywords: ['assinatura', 'serviço', 'servico'] },
];

function normalizeMessage(text: string) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function containsAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function extractAmount(message: string) {
  const match = message.match(/\d{1,3}(?:[\.,]\d{3})*(?:[\.,]\d+)?/);
  if (!match) return { value: null, raw: null };
  const raw = match[0];
  let normalized = raw.replace(/[^\d.,]/g, '');
  const hasComma = normalized.includes(',');
  const hasDot = normalized.includes('.');
  if (hasComma && hasDot) {
    normalized = normalized.replace(/\./g, '');
  }
  normalized = normalized.replace(',', '.');
  const value = Number(normalized);
  if (!Number.isFinite(value)) {
    return { value: null, raw };
  }
  return { value, raw };
}

function extractCardName(message: string) {
  const match = message.match(/cart[ãa]o\s+(?:de\s+|do\s+|da\s+|no\s+|na\s+)?([\w\s]+)/i);
  if (!match) return null;
  const candidate = match[1]
    .split(/(?: no | na | de | do | da | com | e )/i)[0]
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(' ');
  return candidate || null;
}

function detectPaymentMethod(normalized: string) {
  if (normalized.includes('cartao') || normalized.includes('credito')) {
    return 'CREDIT';
  }
  if (
    normalized.includes('dinheiro') ||
    containsPix(normalized) ||
    normalized.includes('debito') ||
    normalized.includes('caixa')
  ) {
    return 'CASH';
  }
  return null;
}

function detectCategoryName(message: string, normalized: string) {
  for (const hint of categoryHints) {
    if (hint.keywords.some((keyword) => normalized.includes(keyword))) {
      return hint.name;
    }
  }
  const explicitMatch = message.match(/categoria(?: de)?\s+([a-zçãáéíóú0-9\s]+)/i);
  if (explicitMatch) {
    return explicitMatch[1].trim();
  }
  const emMatch = message.match(/em\s+([a-zçãáéíóú0-9\s]+)/i);
  if (emMatch) {
    return emMatch[1].trim();
  }
  return null;
}

function buildDescription(message: string, amountFragment: string | null) {
  let description = amountFragment ? message.replace(amountFragment, '') : message;
  description = removePatterns(description, PAYMENT_DESCRIPTION_PATTERNS);
  description = removePatterns(description, DESCRIPTION_CONNECTORS);
  description = description.trim().replace(/\s{2,}/g, ' ');
  if (!description) {
    return 'Despesa';
  }
  return description;
}

function buildAssistantMessageForExpense(amount: number, description: string, detail?: string) {
  const detailSuffix = detail ? ` (${detail})` : '';
  return `Ok, Romário — registrei ${currencyFormatter.format(amount)} em ${description}${detailSuffix}.`;
}

function buildAssistantMessageForIncome(amount: number, description: string, detail?: string) {
  const detailSuffix = detail ? ` (${detail})` : '';
  return `Receita registrada: ${currencyFormatter.format(amount)} — ${description}${detailSuffix}.`;
}

function buildAssistantMessageForUpdate(updates: Record<string, unknown>) {
  const changed = Object.keys(updates)
    .map((key) => `${key} atualizado`)
    .join(', ');
  if (!changed) return 'Tudo pronto, ajustei o último lançamento.';
  return `Atualizei o último lançamento: ${changed}.`;
}

function createEmptyAssistantData(): AssistantModelResponse['data'] {
  return {
    amount: null,
    description: null,
    date: null,
    paymentMethod: null,
    paymentDetail: null,
    installmentCurrent: null,
    installmentTotal: null,
    installmentGroupId: null,
    purchaseLabel: null,
    postedMonth: null,
    cardName: null,
    categoryName: null,
    fieldsToUpdate: null,
    summaryRange: null,
  };
}

function buildNeedsClarification(reason: string): AssistantModelResponse {
  return {
    intent: 'needs_clarification',
    data: createEmptyAssistantData(),
    assistantMessage: reason,
  };
}

export async function interpretAssistantMessageFallback(
  message: string,
  _month?: string,
): Promise<AssistantModelResponse> {
  const parcelInfo = parseInstallmentPattern(message);
  const workingMessage = parcelInfo.cleanedText;
  const normalized = normalizeMessage(workingMessage);
  const baseData = {
    ...createEmptyAssistantData(),
    installmentCurrent: parcelInfo.current,
    installmentTotal: parcelInfo.total,
    purchaseLabel: parcelInfo.purchaseLabel,
  };
  const hasPixMention = containsPix(normalized);

  if (containsAny(normalized, undoKeywords)) {
    return {
      intent: 'undo_last',
      data: baseData,
      assistantMessage: 'Claro, desfazendo o último lançamento agora.',
    };
  }

  if (updatePrefixes.some((prefix) => normalized.startsWith(prefix))) {
    const amountData = extractAmount(message);
    const fields: Record<string, number | string> = {};
    if (amountData.value) fields.amount = amountData.value;
    const paymentMethod = detectPaymentMethod(normalized);
    if (paymentMethod) {
      fields.paymentMethod = paymentMethod;
    }
    if (hasPixMention && !fields.paymentMethod) {
      fields.paymentMethod = 'CASH';
    }
    if (hasPixMention && fields.paymentMethod !== 'CREDIT') {
      fields.paymentDetail = 'PIX';
    }
    const cardName = extractCardName(workingMessage);
    if (cardName) fields.cardName = cardName;
    const categoryName = detectCategoryName(workingMessage, normalized);
    if (categoryName) fields.categoryName = categoryName;
    if (!Object.keys(fields).length) {
      return buildNeedsClarification('O que você quer corrigir? Valor, categoria ou cartão?');
    }
    return {
      intent: 'update_last',
      data: {
        ...baseData,
        fieldsToUpdate: fields,
      },
      assistantMessage: buildAssistantMessageForUpdate(fields),
    };
  }

  if (containsAny(normalized, queryKeywords)) {
    return {
      intent: 'query_summary',
      data: {
        ...baseData,
        summaryRange: 'month',
      },
      assistantMessage: 'Deixa eu calcular o resumo do mês para você.',
    };
  }

  const amountData = extractAmount(workingMessage);
  const amount = amountData.value;

  const isIncome = containsAny(normalized, incomeKeywords);
  if (isIncome) {
    if (!amount) {
      return buildNeedsClarification('Quanto você recebeu?');
    }
    const description = buildDescription(message, amountData.raw);
    return {
      intent: 'create_income',
      data: {
        ...baseData,
        amount,
        description,
        paymentMethod: 'CASH',
        paymentDetail: hasPixMention ? 'PIX' : null,
        installmentCurrent: baseData.installmentCurrent,
        installmentTotal: baseData.installmentTotal,
        purchaseLabel: baseData.purchaseLabel ?? description,
        postedMonth: baseData.postedMonth,
      },
      assistantMessage: buildAssistantMessageForIncome(amount, description, hasPixMention ? 'PIX' : undefined),
    };
  }

  if (!amount) {
    return buildNeedsClarification('Qual valor você quer registrar?');
  }

  const description = buildDescription(workingMessage, amountData.raw);
  const paymentMethod = detectPaymentMethod(normalized) ?? 'CASH';
  const cardName = paymentMethod === 'CREDIT' ? extractCardName(message) : null;
  const categoryName = detectCategoryName(workingMessage, normalized);
  const pixDetail = hasPixMention && paymentMethod !== 'CREDIT' ? 'PIX' : null;

  return {
    intent: 'create_expense',
    data: {
      ...baseData,
      amount,
      description,
      paymentMethod,
      paymentDetail: pixDetail,
      installmentCurrent: baseData.installmentCurrent,
      installmentTotal: baseData.installmentTotal,
      purchaseLabel: baseData.purchaseLabel ?? description,
      cardName,
      categoryName,
    },
    assistantMessage: buildAssistantMessageForExpense(amount, description, pixDetail ?? undefined),
  };
}
