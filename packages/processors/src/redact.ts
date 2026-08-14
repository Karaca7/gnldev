// PII regexes + message/string redaction helpers. Pure (deterministic) → no journaling needed.
//
// HONEST WARNING (naive regex matching): These patterns are best-effort — they do NOT provide a real
// PII DETECTION/compliance (GDPR/HIPAA/PCI-DSS) guarantee, they can be easily missed (unusual format,
// International format, unstructured PII like name/address) or produce false positives. Use as a
// Noise-reduction / first-line-of-defense layer, do NOT RELY on it as the SOLE mechanism for critical
// Compliance decisions.

export type PiiType = 'email' | 'phone' | 'creditCard' | 'ssn' | 'ip';

export const PII_PATTERNS: Record<PiiType, RegExp> = {
  email: /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  // 16-digit card (grouped with spaces/dashes): 4-4-4-4
  creditCard: /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  ip: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  // E.g. +90 555 123 4567 / 555-123-4567 (at least 7 digits)
  phone: /\+?\d[\d\s().-]{7,}\d/g,
};

// Apply creditCard/ssn/ip BEFORE phone (the phone pattern can also catch them).
// EXPORT: used by pii.ts's audit report (recordProcessorReport) to derive the redaction COUNT in the
// Same order — shares the same application order WITHOUT CHANGING redactString's behavior.
export const ORDER: PiiType[] = ['email', 'creditCard', 'ssn', 'ip', 'phone'];

export function redactString(s: string, types: PiiType[], mask: (t: PiiType) => string): string {
  let out = s;
  // Apply creditCard/ssn/ip BEFORE phone (the phone pattern can also catch them).
  for (const t of ORDER) {
    if (!types.includes(t)) continue;
    const re = PII_PATTERNS[t];
    out = out.replace(new RegExp(re.source, re.flags), mask(t));
  }
  return out;
}

/** Redacts a message list (string or parts-array content); returns a copy. */
export function redactMessages(messages: any[], types: PiiType[], mask: (t: PiiType) => string): any[] {
  return messages.map((m) => {
    if (typeof m?.content === 'string') {
      return { ...m, content: redactString(m.content, types, mask) };
    }
    if (Array.isArray(m?.content)) {
      return {
        ...m,
        content: m.content.map((part: any) =>
          typeof part?.text === 'string' ? { ...part, text: redactString(part.text, types, mask) } : part,
        ),
      };
    }
    return m;
  });
}
