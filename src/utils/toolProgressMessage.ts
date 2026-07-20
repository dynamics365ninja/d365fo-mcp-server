/**
 * Builds a human-readable progress/status description for a given tool call.
 * Used in two places:
 *   - stdio mode  → sent as MCP notifications/message BEFORE the tool runs (visible in chat)
 *   - HTTP mode   → prepended to the tool result text (visible when expanding the tool call)
 */
export function buildProgressMessage(toolName: string, args: Record<string, any> | undefined): string {
  const a = args ?? {};
  switch (toolName) {
    case 'search':
      if (Array.isArray(a.queries)) {
        return `🔍 Batch search: ${a.queries.map((q: any) => `"${q.query ?? q}"`).join(', ')}`;
      }
      if (a.scope === 'extensions') {
        return `🔍 Searching custom extensions: "${a.query ?? ''}"`;
      }
      return `🔍 Searching D365FO index: "${a.query ?? ''}"${a.type ? ` [${a.type}]` : ''}`;
    case 'get_object_info':
      return `📦 Reading ${a.objectType ?? 'object'} ${a.name ?? ''}`;
    case 'get_method':
      return `📖 Reading ${a.include === 'signature' ? 'signature' : a.include === 'source' ? 'source' : 'method'} of ${a.className ?? ''}.${a.methodName ?? ''}`;
    case 'find_references':
      return `🔗 Finding references to ${a.targetName ?? ''}`;
    case 'extension_info':
      switch (a.mode) {
        case 'events':      return `🔗 Finding event handlers for ${a.target ?? ''}`;
        case 'table-merge': return `🔧 Reading extensions of table ${a.target ?? ''}`;
        case 'points':      return `🔍 Analyzing extension points of ${a.target ?? ''}`;
        case 'strategy':    return `💡 Recommending extension strategy for "${a.goal ?? ''}"${a.target ? ` on ${a.target}` : ''}`;
        default:            return `🔗 Finding CoC extensions of ${a.target ?? ''}${a.method ? `.${a.method}` : ''}`;
      }
    case 'security_info':
      return a.mode === 'coverage'
        ? `🔒 Reading security coverage for ${a.objectName ?? ''}`
        : `🔒 Reading security artifact ${a.name ?? ''}`;
    case 'analyze_code':
      switch (a.mode) {
        case 'implementations': return `💡 Suggesting implementation for ${a.className ?? ''}.${a.methodName ?? ''}`;
        case 'completeness':    return `✅ Analyzing completeness of class ${a.className ?? ''}`;
        case 'api-usage':       return `📐 API usage patterns for ${a.apiName ?? ''}`;
        default:                return `📐 Analyzing code patterns: "${a.scenario ?? ''}"`;
      }
    case 'd365fo_file':
      switch (a.action) {
        case 'modify': {
          const op = a.operation ?? 'modify';
          // Op-specific parameters (methodName, fieldName, indexName, …) may arrive
          // nested in `params` rather than flat at top level — merge so the label
          // reflects the real values instead of showing blanks.
          const p = { ...a, ...(a.params ?? {}) };
          // Callers that just created the object pass `filePath` instead of
          // `objectName`; fall back to the file's basename so the label isn't empty.
          const objName = a.objectName
            ?? (typeof a.filePath === 'string'
              ? a.filePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.xml$/i, '')
              : undefined);
          const obj = `${a.objectType ?? 'object'} ${objName ?? ''}`.trim();
          switch (op) {
            case 'add-index':
            case 'remove-index': {
              const fields = Array.isArray(p.indexFields)
                ? p.indexFields.map((f: any) => f.fieldName ?? f).join(', ')
                : '';
              return `✏️ ${op} "${p.indexName ?? ''}"${fields ? ` [${fields}]` : ''} on ${obj}`;
            }
            case 'add-relation':
            case 'remove-relation': {
              const constraints = Array.isArray(p.relationConstraints)
                ? p.relationConstraints.map((c: any) => `${c.fieldName ?? c.field} → ${c.relatedFieldName ?? c.relatedField}`).join(', ')
                : '';
              return `✏️ ${op} "${p.relationName ?? ''}"${p.relatedTable ? ` → ${p.relatedTable}` : ''}${constraints ? ` [${constraints}]` : ''} on ${obj}`;
            }
            case 'modify-property':
              return `✏️ ${op} ${p.propertyPath ?? ''}${p.propertyValue !== undefined ? ` = ${String(p.propertyValue).slice(0, 40)}` : ''} on ${obj}`;
            case 'add-method':
            case 'remove-method':
            case 'add-table-method':
            case 'add-display-method': {
              // methodName is optional for add-method — it is derived from the
              // source signature downstream; derive it here too for the label.
              const name = p.methodName ?? deriveMethodNameForLabel(p.sourceCode) ?? '';
              return `✏️ ${op} "${name}" on ${obj}`;
            }
            case 'add-field':
            case 'modify-field':
            case 'rename-field':
            case 'remove-field':
              return `✏️ ${op} "${p.fieldName ?? ''}"${p.fieldNewName ? ` → "${p.fieldNewName}"` : ''} on ${obj}`;
            case 'add-enum-value':
            case 'modify-enum-value':
            case 'remove-enum-value':
              return `✏️ ${op} "${p.enumValueName ?? ''}" on ${obj}`;
            default:
              return `✏️ ${op} on ${obj}`;
          }
        }
        case 'generate': return `🔧 Generating XML for ${a.objectType ?? 'object'} ${a.objectName ?? ''}`;
        default:         return `📁 Creating ${a.objectType ?? 'object'} ${a.objectName ?? ''}`;
      }
    case 'generate_object':
      if (a.mode === 'scaffold') {
        const kind = (a.objectType as string) ?? 'object';
        return `🏗️ Generating ${kind} ${a.name ?? ''}`;
      }
      return `🔧 Generating code pattern "${a.pattern ?? ''}" for ${a.name ?? ''}`;
    case 'object_patterns':
      if (a.domain === 'table') {
        return `📐 Getting table patterns${a.tableGroup ? ` [${a.tableGroup}]` : ''}${a.similarTo ? ` similar to ${a.similarTo}` : ''}`;
      }
      switch (a.action) {
        case 'validate': return `✅ Validating form pattern${a.formName ? ` of ${a.formName}` : ''}`;
        case 'spec':     return `📐 Form pattern spec${a.pattern ? `: ${a.pattern}` : ''}`;
        default:         return `📐 Analyzing form patterns${a.formPattern ? ` [${a.formPattern}]` : ''}`;
      }
    case 'suggest_edt':
      return `💡 Suggesting EDT for field "${a.fieldName ?? ''}"`;
    case 'prepare':
      return `🧭 Preparing ${a.mode === 'create' ? 'create' : 'change'} context${a.objectName ? ` for ${a.objectName}` : ''}`;
    case 'labels': {
      const action = (a.action as string) ?? '';
      switch (action) {
        case 'search':
          return `🏷️ Searching labels: "${a.query ?? ''}"`;
        case 'info':
          return `🏷️ Reading label info${a.labelId ? ` for ${a.labelId}` : ''}`;
        case 'create':
          return `🏷️ Creating label ${a.labelId ?? ''}`;
        case 'rename':
          return `🏷️ Renaming label ${a.oldLabelId ?? ''} → ${a.newLabelId ?? ''}`;
        default:
          return `🏷️ Label operation${action ? ` (${action})` : ''}`;
      }
    }
    case 'validate_object_naming':
      return `✅ Validating name "${a.proposedName ?? ''}" for ${a.objectType ?? ''}`;
    case 'verify_d365fo_project':
      return `✅ Verifying D365FO project${a.projectPath ? ` at ${a.projectPath}` : ''}`;
    case 'update_symbol_index':
      return `🔄 Updating symbol index${a.filePath ? ` for ${a.filePath}` : ''}`;
    case 'build_d365fo_project':
      return `🔨 Building D365FO project${a.projectPath ? ` ${a.projectPath}` : ''}`;
    case 'trigger_db_sync':
      return `🗄️ Triggering database sync${a.tableName ? ` for ${a.tableName}` : ''}`;
    case 'run_bp_check':
      return `🔍 Running Best Practices check${a.targetFilter ? ` on ${a.targetFilter}` : ''}`;
    case 'run_systest_class':
      return `🧪 Running unit tests: ${a.className ?? ''}`;
    case 'review_workspace_changes':
      return `🔍 Reviewing workspace changes${a.directoryPath ? ` in ${a.directoryPath}` : ''}`;
    case 'undo_last_modification':
      return `↩️ Undoing last modification${a.filePath ? ` of ${a.filePath}` : ''}`;
    case 'get_workspace_info':
      return `⚙️ Reading workspace configuration`;
    case 'get_knowledge':
      return a.kind === 'error'
        ? `🆘 Looking up D365FO error: "${String(a.errorText ?? '').slice(0, 80)}"`
        : `📚 Reading X++ knowledge: "${a.topic ?? ''}"`;
    case 'validate_code':
      return a.mode === 'references'
        ? `🔎 Resolving symbol references in generated code`
        : `✅ Validating X++/XML (best-practice rules)`;
    default:
      return `⚙️ Running ${toolName}`;
  }
}

/**
 * Best-effort method-name extraction for the progress label only, used when an
 * add-method call omits `methodName` and relies on downstream derivation from the
 * source. Strips line/block comments, then returns the identifier before the first
 * '(' of the signature. Not authoritative — the bridge derives the real name.
 */
function deriveMethodNameForLabel(source: unknown): string | null {
  if (typeof source !== 'string' || !source) return null;
  const cleaned = source
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\[[^\]]*\]/g, ' ');
  const m = cleaned.match(/\b([A-Za-z_]\w*)\s*\(/);
  return m ? m[1] : null;
}
