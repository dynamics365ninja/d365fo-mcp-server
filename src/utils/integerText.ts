/**
 * A whole-number metadata property (StringSize, DisplayLength, …) as the text the index
 * stores, or null when there is none.
 *
 * extract-metadata reads these from AxEdt XML and writes text ('15'). The binary ISV importer
 * wrote the dump's JSON number (15), and node:sqlite binds every JS number as a REAL, which a
 * TEXT column stores as '15.0' — so the readers printed "String Size 15.0". A number is
 * truncated to an integer; text that is an integer with a zero fraction ('15.0', from an
 * index built before this was normalised) loses the fraction; any other text is kept as is.
 */
export function integerText(value: unknown): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.trunc(value)) : null;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const zeroFraction = /^(-?\d+)\.0+$/.exec(text);
  return zeroFraction ? zeroFraction[1] : text;
}
