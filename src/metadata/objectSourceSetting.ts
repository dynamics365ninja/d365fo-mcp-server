/**
 * index.storeObjectSource (STORE_OBJECT_SOURCE): whether the index keeps a copy of every
 * object's original XML — as `raw` in the extracted JSON and gzipped in object_source.
 *
 * On unless set to "false", like INCLUDE_LABELS. Its own module so extract-metadata can
 * read it without loading the symbol index.
 */
export function storeObjectSourceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STORE_OBJECT_SOURCE !== 'false';
}
