const PARCEL_PATTERN = /\bparcela\s+(\d{1,3})\s*(?:de|\/)\s*(\d{1,3})\b/i;

export interface InstallmentPatternResult {
  current: number | null;
  total: number | null;
  cleanedText: string;
  purchaseLabel: string | null;
}

export function parseInstallmentPattern(text: string): InstallmentPatternResult {
  const match = PARCEL_PATTERN.exec(text);
  if (!match) {
    return { current: null, total: null, cleanedText: text, purchaseLabel: null };
  }

  const [, currentStr, totalStr] = match;
  const current = Number.parseInt(currentStr, 10);
  const total = Number.parseInt(totalStr, 10);
  const normalizedCurrent = Number.isFinite(current) ? current : null;
  const normalizedTotal = Number.isFinite(total) ? total : null;
  const cleanedText = (text.slice(0, match.index) + text.slice(match.index + match[0].length))
    .replace(/\s+/g, ' ')
    .trim();
  const prefix = text.slice(0, match.index).trim();
  const label = prefix ? prefix : null;

  const validCurrent = normalizedCurrent !== null && normalizedCurrent >= 1 ? normalizedCurrent : null;
  const validTotal = normalizedTotal !== null && normalizedTotal >= 1 ? normalizedTotal : null;

  return {
    current: validCurrent,
    total: validTotal,
    cleanedText: cleanedText || text,
    purchaseLabel: label,
  };
}
