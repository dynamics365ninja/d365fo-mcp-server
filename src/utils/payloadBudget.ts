/**
 * Bounding the size of reader responses.
 *
 * A reader payload is billed twice — once when the tool returns, and again on
 * every later round trip that re-reads the conversation — so an unbounded list
 * is the most expensive thing this server can emit. Three readers had one:
 * every field of a Microsoft table (CustTable is ~400 fields; methods already
 * paged, fields did not), the whole control tree of a platform form, and a 2 MB
 * embedded RDL. These helpers exist so those three use ONE paging/capping UX
 * instead of inventing a second and third one next to the method pager.
 */

/** Fields per page. Sized so a paged table header+fields stays near the method page's cost. */
export const TABLE_FIELD_PAGE_SIZE = 50;

/** Controls rendered before the tree is cut. A platform form can carry >1000. */
export const DEFAULT_MAX_CONTROLS = 150;

export interface FieldPage<T> {
  visible: T[];
  /** Fields on the object, before filtering. */
  total: number;
  /** Fields left after `filter` (=== total when no filter). */
  matched: number;
  offset: number;
  filter?: string;
  hasMore: boolean;
  pageSize: number;
}

/**
 * Apply `fieldFilter` then `fieldsOffset`, mirroring the method pager's contract
 * (offset in multiples of the page size, caller-visible totals).
 */
export function pageFields<T extends { name: string }>(
  fields: T[],
  offset = 0,
  filter?: string,
  pageSize: number = TABLE_FIELD_PAGE_SIZE,
): FieldPage<T> {
  const total = fields.length;
  const needle = filter?.trim().toLowerCase();
  const matching = needle ? fields.filter(f => f.name.toLowerCase().includes(needle)) : fields;
  const start = Math.max(0, Math.floor(offset) || 0);
  return {
    visible: matching.slice(start, start + pageSize),
    total,
    matched: matching.length,
    offset: start,
    filter: needle ? filter : undefined,
    hasMore: start + pageSize < matching.length,
    pageSize,
  };
}

/** Heading text (without the `## ` prefix) that states what the page is a page OF. */
export function fieldsHeading<T>(page: FieldPage<T>): string {
  if (page.filter) {
    return `Fields (${page.matched} of ${page.total} matching "${page.filter}"` +
      (page.matched > page.pageSize ? `, showing ${page.offset + 1}–${Math.min(page.offset + page.pageSize, page.matched)}` : '') + ')';
  }
  if (page.total > page.pageSize) {
    return `Fields (${page.total} total, showing ${page.offset + 1}–${Math.min(page.offset + page.pageSize, page.total)})`;
  }
  return `Fields (${page.total})`;
}

/**
 * Footer for a cut field list. Empty when nothing was hidden. Names both ways
 * out — next page and filter — because "call again with an offset" alone makes
 * the agent walk 400 fields one page at a time to find the one it wanted.
 */
export function fieldsFooter<T>(page: FieldPage<T>): string {
  if (!page.hasMore) return '';
  const hidden = page.matched - page.offset - page.pageSize;
  return `\n> ⚠️ **${hidden} more fields.** Call again with \`fieldsOffset: ${page.offset + page.pageSize}\`` +
    `, or narrow with \`fieldFilter: "<substring>"\` instead of paging through them.\n`;
}

/** Mutable render budget threaded through a recursive control-tree walk. */
export interface ControlBudget {
  remaining: number;
  omitted: number;
  max: number;
}

export function createControlBudget(max: number = DEFAULT_MAX_CONTROLS): ControlBudget {
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_MAX_CONTROLS;
  return { remaining: cap, omitted: 0, max: cap };
}

/**
 * Charge one control to the budget. `false` means "do not render this node or
 * its children" — the caller still recurses nowhere, and the omission is counted
 * so the footer can quantify it.
 */
export function chargeControl(budget: ControlBudget): boolean {
  if (budget.remaining <= 0) {
    budget.omitted++;
    return false;
  }
  budget.remaining--;
  return true;
}

/** Count a subtree that was skipped wholesale (parent already over budget). */
export function chargeSkippedSubtree(budget: ControlBudget, count: number): void {
  budget.omitted += count;
}

export function controlsFooter(budget: ControlBudget): string {
  if (budget.omitted <= 0) return '';
  return `\n> ⚠️ **${budget.omitted} more controls not shown** (capped at ${budget.max}). ` +
    `Use \`searchControl: "<name>"\` to jump straight to one control, or raise the cap with ` +
    `\`maxControls: ${budget.max + budget.omitted}\` if you really need the whole tree.\n`;
}

/**
 * Cut `text` to at most `cap` characters WITHOUT ending inside an XML element or
 * mid-line. A raw `slice(0, cap)` on report RDL or generated XML routinely
 * produced a dangling `<Textbox Nam` — output that reads as corrupt metadata
 * rather than as truncated metadata, and that an agent will happily copy.
 *
 * Boundaries are tried best-first (blank line, then newline) and only accepted
 * when they keep at least 80% of the cap, so a single very long line still gets
 * most of its budget; whatever the cut lands on, a trailing partial `<…` tag is
 * always backed off to the last complete `>`.
 */
export function truncateOnBlockBoundary(text: string, cap: number): string {
  if (text.length <= cap) return text;

  const minCut = Math.floor(cap * 0.8);
  let cut = cap;
  const para = text.lastIndexOf('\n\n', cap);
  const line = text.lastIndexOf('\n', cap);
  if (para >= minCut) cut = para;
  else if (line >= minCut) cut = line;

  const head = text.slice(0, cut);
  const lastOpen = head.lastIndexOf('<');
  const lastClose = head.lastIndexOf('>');
  if (lastOpen > lastClose) cut = lastClose >= 0 ? lastClose + 1 : 0;

  return text.slice(0, cut);
}
