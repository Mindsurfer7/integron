/** Exact quotations from untrusted third-party text: no inferred or verified claims.
 * All candidates carry source offsets. Contradictory source statements are
 * surfaced as conflicting rather than silently selecting the first match.
 */
export type FactField = 'price' | 'availability' | 'delivery';
export type FactStatus = 'tentative' | 'conflicting';
export interface EvidenceCandidate {
  field: FactField;
  value: string;
  quote: string;
  startOffset: number;
  endOffset: number;
  status: FactStatus;
}

const PRICE = /(?<![\p{L}\p{N}])(?:\d[\d \u00a0.,]{0,15}\s?(?:THB|USD|EUR|RUB|руб(?:лей|ля)?|бат(?:ов|а)?|₽|\$|€)|[\$€₽]\s?\d[\d \u00a0.,]{0,15})(?![\p{L}])/giu;
const UNAVAILABLE = /(?<![\p{L}])(?:нет в наличии|не доступн[а-я]*|out of stock|not available|sold out)(?![\p{L}])/giu;
const AVAILABLE = /(?<![\p{L}])(?:есть в наличии|в наличии|доступн[а-я]*|in stock|available)(?![\p{L}])/giu;
const DELIVERY = /(?<![\p{L}\p{N}])\d{1,3}\s?(?:дн(?:я|ей|ь)|час(?:а|ов)?|weeks?|days?|hours?)(?![\p{L}])/giu;
const PER_FIELD_LIMIT = 8;

/** Only text spans actually present in the message can become facts. */
function collect(text: string, pattern: RegExp, field: FactField): EvidenceCandidate[] {
  return Array.from(text.matchAll(pattern), match => {
    const quote = match[0];
    return {
      field, value: quote, quote, startOffset: match.index,
      endOffset: match.index + quote.length, status: 'tentative' as const
    };
  }).slice(0, PER_FIELD_LIMIT);
}

function overlaps(a: EvidenceCandidate, b: EvidenceCandidate): boolean {
  return a.startOffset < b.endOffset && b.startOffset < a.endOffset;
}

export function extractQuotedFacts(text: string): EvidenceCandidate[] {
  if (typeof text !== 'string' || text.length > 2000) return [];
  const prices = collect(text, PRICE, 'price');
  const negative = collect(text, UNAVAILABLE, 'availability');
  // The string 'not available' must never also count as a positive 'available'.
  const positive = collect(text, AVAILABLE, 'availability')
    .filter(item => !negative.some(n => overlaps(item, n)));
  const availability = [...negative, ...positive]
    .sort((a, b) => a.startOffset - b.startOffset).slice(0, PER_FIELD_LIMIT);
  const delivery = collect(text, DELIVERY, 'delivery');

  // Multiple distinct prices, availability assertions or delivery intervals
  // are ambiguous without knowing which product/offer each refers to.
  for (const group of [prices, availability, delivery]) {
    if (new Set(group.map(f => f.quote.toLocaleLowerCase().replace(/\s+/g, ' ').trim())).size > 1) {
      for (const candidate of group) candidate.status = 'conflicting';
    }
  }
  return [...prices, ...availability, ...delivery];
}
