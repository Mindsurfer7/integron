/** Conservative extraction: save literal quoted source spans, never inferred facts.
 * Third-party replies are data (not commands). No regex guesses without a quote.
 * Caller must attach the persisted message ID and commit facts atomically with state.
 */
export type FactField = 'price' | 'availability' | 'delivery';
export interface EvidenceCandidate {
  field: FactField;
  value: string;
  quote: string;
  startOffset: number;
  endOffset: number;
  status: 'tentative';
}
function matchAt(text: string, re: RegExp, field: FactField, group = 0): EvidenceCandidate | null {
  const match = re.exec(text);
  if (!match) return null;
  const quote = match[group];
  if (!quote) return null;
  const relative = match[0].indexOf(quote);
  const startOffset = match.index + relative;
  return { field, value: quote, quote, startOffset,
    endOffset: startOffset + quote.length, status: 'tentative' };
}
export function extractQuotedFacts(text: string): EvidenceCandidate[] {
  if (typeof text !== 'string' || text.length > 2000) return [];
  const candidates: EvidenceCandidate[] = [];
  // Require explicit currency to avoid treating arbitrary IDs as prices.
  const price = matchAt(text, /(?:\b\d[\d \u00a0.,]{0,15}\s?(?:THB|USD|EUR|RUB|руб(?:лей|ля)?|бат(?:ов|а)?|₽|\$|€)\b|[$€₽]\s?\d[\d \u00a0.,]{0,15})/i, 'price');
  if (price) candidates.push(price);
  // Negative patterns first; do not incorrectly claim availability from "нет в наличии".
  const unavailable = matchAt(text, /\b(?:нет в наличии|не доступн[а-я]*|out of stock|not available|sold out)\b/i, 'availability');
  const available = unavailable ? null :
    matchAt(text, /\b(?:есть в наличии|в наличии|доступн[а-я]*|in stock|available)\b/i, 'availability');
  if (unavailable || available) candidates.push((unavailable ?? available)!);
  const time = matchAt(text, /\b\d{1,3}\s?(?:дн(?:я|ей|ь)|час(?:а|ов)?|weeks?|days?|hours?)\b/i, 'delivery');
  if (time) candidates.push(time);
  return candidates;
}
