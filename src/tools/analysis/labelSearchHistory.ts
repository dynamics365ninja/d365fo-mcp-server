/**
 * The phrasings already tried against the labels index, and how many calls tried them.
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

/**
 * Search calls allowed before the answer is declared settled.
 *
 * Two, because the second call is the one that establishes the index has nothing
 * new to give: the first is an honest look, the second is the rephrase everyone
 * tries anyway. Counted in CALLS, not phrasings — a call is a round trip, which
 * is what the loop actually costs (~2-3 AIU each), and a batched
 * `query=["…","…","…"]` is the cheap shape this must not punish.
 */
const SEARCH_CALL_BUDGET = 2;

interface Entry {
  /** The phrasing as the caller spelled it — echoing it back is the point. */
  query: string;
  at: number;
  /** False once the search came back with something this model can resolve. */
  fruitless: boolean;
}

const history: Entry[] = [];

/** One timestamp per search CALL, so the TTL prunes calls the way it prunes phrasings. */
const calls: number[] = [];

function prune(now: number): void {
  while (history.length > 0 && now - history[0].at > HISTORY_TTL_MS) history.shift();
  while (calls.length > 0 && now - calls[0] > HISTORY_TTL_MS) calls.shift();
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
 * Count one search CALL, whatever it is about to return.
 *
 * Separate from recordLabelSearch because that one only counts what a phrasing
 * found, and a phrasing that hit something irrelevant is invisible to it. Run
 * 7b8de4ba is the case: six batches / 24 phrasings in, the notice was still
 * reporting "11 phrasing(s) already came back empty", because the other thirteen
 * had each landed on some unrelated SYS label and were never counted.
 */
export function recordLabelSearchCall(): void {
  const now = Date.now();
  prune(now);
  calls.push(now);
}

/** Search calls made in this session. */
export function labelSearchCallCount(): number {
  prune(Date.now());
  return calls.length;
}

/**
 * The hard stop, once the caller is past the budget. Empty until then.
 *
 * Unlike repeatSearchNotice this does not care whether the searches came back
 * empty: the expensive loop is the one where every batch DOES return something,
 * none of it about the caller's subject, and the verdict reads as encouragement
 * to try another wording. Both branches carry this, so the count is the thing
 * that ends the loop rather than the luck of the phrasing.
 *
 * Names the escalations that follow the loop in practice — reading the
 * .label.txt files by hand, asking the user — because those cost more than the
 * searches did and are what the caller reaches for once it stops rephrasing.
 */
export function searchBudgetNotice(): string {
  prune(Date.now());
  if (calls.length <= SEARCH_CALL_BUDGET) return '';

  return (
    `🛑 **STOP — that was label search call ${calls.length} this session** ` +
    `(${history.length} phrasing(s) in total). They all query the same index, so the answer stopped ` +
    `changing after the first call: what has come back IS what exists. Do not search again, do not ` +
    `read the .label.txt files by hand, and do not ask the user. Take a hit from above if one says ` +
    `what you need; otherwise create your own label with the call below and move on.\n`
  );
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
  calls.length = 0;
}
