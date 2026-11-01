/**
 * Label text equality, for labels(action="search", exact=true).
 *
 * The full-text search matches words, so "the label whose text is exactly X"
 * came back as dozens of candidates for the caller to compare by hand. Exact
 * lookup compares whole texts instead, after this normalisation on both sides.
 *
 * Done in JS on purpose, not with SQLite's LOWER(): that one folds ASCII only,
 * so LOWER('PRÜFUNG') is 'prÜfung' and an umlaut in different case would never
 * compare equal. String.prototype.toLowerCase is the Unicode default case
 * mapping and does not depend on the process locale (toLocaleLowerCase would).
 */

/**
 * Unicode NFC, trimmed, inner whitespace runs collapsed to one space, lower-cased.
 * Nothing else: no stemming, no diacritic folding, no punctuation stripping.
 */
export function normalizeLabelText(text: string): string {
  return String(text ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}
