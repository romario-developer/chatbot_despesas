const INSTALLMENT_REGEX = /\b(\d{1,2})\s*[x×]\b/i;

export interface InstallmentInfo {
  installmentsTotal: number;
  cleanedText: string;
}

export function parseInstallments(text: string): InstallmentInfo {
  const normalized = text.replace(/[\u00a0]/g, ' ');
  const match = normalized.match(INSTALLMENT_REGEX);
  if (!match) {
    return { installmentsTotal: 1, cleanedText: text };
  }

  const total = Number.parseInt(match[1], 10);
  if (!Number.isInteger(total) || total <= 1) {
    return { installmentsTotal: 1, cleanedText: text };
  }

  const cleaned = normalized.replace(match[0], ' ').replace(/\s+/g, ' ').trim();
  return { installmentsTotal: total, cleanedText: cleaned || text };
}
