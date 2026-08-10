/**
 * The phrasings already tried against the labels index.
 *
 * Every search result says rephrasing does not help; callers rephrase anyway.
 * Naming the wordings they already tried is harder to argue with than the same
 * advice stated in the abstract.
 *
 * Advisory, not a refusal: this process outlives one chat session, so leftover
 * state must never block a legitimate first search. Hence the TTL and a note.
 */

/** Older entries are forgotten — this process is shared across chat sessions. */
const HISTORY_TTL_MS = 30 * 60 * 1000;

/** Beyond this many remembered phrasings, the list is summarised rather than printed. */
const MAX_LISTED = 12;

interface Entry {
  /** The phrasing as the caller spelled it — echoing it back is the point. */
  query: string;
  at: number;
  /** False once the search came back with something this model can resolve. */
  fruitless: boolean;
}

const history: Entry[] = [];

function prune(now: number): void {
  while (history.length > 0 && now - history[0].at > HISTORY_TTL_MS) history.shift();
}

/** Record one search and whether it came back empty-handed. */
export function recordLabelSearch(query: string, fruitless: boolean): void {
  const now = Date.now();
  prune(now);
  const key = query.trim().toLowerCase();
  if (key === '') return;
  const existing = history.find(e => e.query.trim().toLowerCase() === key);
  if (existing) {
    existing.at = now;
    // A phrasing that found something once is not fruitless, however often it is
    // repeated — only the empty-handed ones are what this counts.
    existing.fruitless = existing.fruitless && fruitless;
    return;
  }
  history.push({ query, at: now, fruitless });
}

/** Phrasings tried in this session that found nothing, oldest first. */
export function fruitlessLabelSearches(): string[] {
  prune(Date.now());
  return history.filter(e => e.fruitless).map(e => e.query);
}

/**
 * The line that goes at the top of a no-hit answer once the caller has been here
 * before. Empty until then — the first miss is ordinary and needs no lecture.
 *
 * `excluding` drops the current call's own phrasings, so a six-query batch does
 * not read as six previous attempts.
 */
export function repeatSearchNotice(excluding: readonly string[] = []): string {
  const skip = new Set(excluding.map(q => q.trim().toLowerCase()));
  const prior = fruitlessLabelSearches().filter(q => !skip.has(q.trim().toLowerCase()));
  if (prior.length === 0) return '';

  const listed = prior.length > MAX_LISTED
    ? `${prior.slice(0, MAX_LISTED).map(q => `"${q}"`).join(', ')} … and ${prior.length - MAX_LISTED} more`
    : prior.map(q => `"${q}"`).join(', ');

  return (
    `🛑 **This is not new information.** ${prior.length} phrasing(s) already came back empty here: ` +
    `${listed}. They all query the same index, so this answer was settled by the first of them. ` +
    `Create the label and move on — searching again cannot change it.\n`
  );
}

/** Forget everything. Tests only. */
export function resetLabelSearchHistory(): void {
  history.length = 0;
}
