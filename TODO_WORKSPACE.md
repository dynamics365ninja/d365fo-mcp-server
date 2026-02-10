# TODO: Workspace-Aware Features

## 🎯 Implementované (✅)

- ✅ **WorkspaceScanner** - Skenování lokálních X++ souborů
- ✅ **HybridSearch** - Kombinace external + workspace metadata
- ✅ **Context Extension** - `workspaceScanner` a `hybridSearch` v XppServerContext
- ✅ **Search Tool** - `includeWorkspace` a `workspacePath` parametry
- ✅ **Workspace Resources** - MCP resources pro stats a file listing
- ✅ **Prioritizace Workspace** - 🔹 označení workspace kódu
- ✅ **Fuzzy Matching** - Levenshtein distance pro lepší výsledky
- ✅ **Caching** - 5-minutové cachování workspace scanů
- ✅ **Dokumentace** - WORKSPACE_AWARE.md a README sekce

---

## 🚧 Zbývá Dodělat

### 1️⃣ **Vysoká Priorita**

#### 🔴 Editor Context Support
- [ ] **Aktivní soubor v editoru** - Detekce otevřeného souboru v VS Code/VS2022
- [ ] **Cursor position** - Získání aktuální pozice kurzoru pro kontextovou analýzu
- [ ] **Selection** - Podpora analyzování vybraného kódu
- [ ] **Modified files tracking** - Sledování neuložených změn

**Implementation:**
```typescript
interface EditorContext {
  activeFile?: {
    path: string;
    content: string;
    cursorLine: number;
    cursorColumn: number;
  };
  selection?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
    text: string;
  };
  modifiedFiles: Map<string, string>; // path -> unsaved content
}
```

**Použití:**
```typescript
// Analýza kódu v aktuálně otevřeném souboru
analyze_code_patterns("dimension", {
  useEditorContext: true  // Analyzuje soubor který máš otevřený!
})
```

---

#### 🔴 Integrace do Ostatních Tools

**Nástroje k rozšíření:**

- [ ] **`get_class_info`** - Preferovat workspace verzi před external
- [ ] **`get_table_info`** - Preferovat workspace verzi před external  
- [ ] **`code_completion`** - Nabízet metody z workspace prioritně
- [ ] **`analyze_code_patterns`** - Analyzovat workspace jako primární zdroj
- [ ] **`suggest_method_implementation`** - Hledat implementace ve workspace
- [ ] **`analyze_class_completeness`** - Porovnávat s workspace patterns
- [ ] **`get_api_usage_patterns`** - Ukázat jak VY používáte API

**Příklad:**
```typescript
get_class_info("CustTable", {
  includeWorkspace: true,
  workspacePath: "C:\\MyProject"
})
// Výsledek:
// 🔹 WORKSPACE Extension: CustTable_MyExtension
//    - method validateCustomField()
// 📦 EXTERNAL Standard: CustTable
//    - method validateWrite()
```

---

#### 🔴 XML Metadata Parsing ve Workspace

Aktuálně WorkspaceScanner **pouze detekuje soubory**, neanalyzuje jejich obsah.

- [ ] **Parse AxClass XML** - Extrahovat metody, fieldy, inheritance
- [ ] **Parse AxTable XML** - Extrahovat fields, relations, indexes
- [ ] **Parse AxForm XML** - Extrahovat controls, data sources
- [ ] **Parse AxEnum XML** - Extrahovat enum values

**Benefits:**
- 🎯 Přesné signatury metod z workspace
- 🎯 IntelliSense pro custom extension metody
- 🎯 Validace že volané metody existují

---

### 2️⃣ **Střední Priorita**

#### 🟡 Incremental Workspace Index

Aktuálně každý scan prohledává celý workspace. Pro velké projekty (1000+ souborů) to může trvat i několik sekund.

- [ ] **SQLite workspace index** - Samostatná DB pro workspace
- [ ] **File watcher** - Sledování změn v reálném čase
- [ ] **Incremental updates** - Update jen změněných souborů
- [ ] **Workspace cache invalidation** - Inteligentní invalidace cache

**Výhody:**
- ⚡ Sub-10ms workspace search (místo 100ms)
- 🔄 Real-time updates při změnách souborů
- 💾 Perzistentní index mezi restarty

---

#### 🟡 Symbol Resolution

- [ ] **Cross-file references** - Sledování závislostí mezi soubory
- [ ] **Inheritance chain** - Řetězení dědičnosti i přes workspace
- [ ] **Method overrides** - Detekce override metod
- [ ] **Interface implementations** - Mapování implementací interfaců

**Use Case:**
```typescript
// Najdi všechny třídy které implementují ISalesLineProcessor
search_implementations("ISalesLineProcessor", {
  includeWorkspace: true
})
```

---

#### 🟡 Semantic Workspace Analysis

- [ ] **Import analysis** - Jaké třídy soubor používá
- [ ] **Dependency graph** - Graf závislostí workspace
- [ ] **Unused code detection** - Detekce nepoužívaného kódu
- [ ] **Impact analysis** - Co se pokazí když změním tuhle metodu?

---

### 3️⃣ **Nízká Priorita (Nice to Have)**

#### 🟢 Git Integration

- [ ] **Changed files detection** - Co se změnilo od posledního commitu
- [ ] **Blame integration** - Kdo napsal tenhle kód
- [ ] **PR-aware search** - Hledat jen v souborech z aktuálního PR

---

#### 🟢 Multi-Workspace Support

- [ ] **Multiple workspace paths** - Podpora více projektů najednou
- [ ] **Workspace groups** - Logické skupiny workspace folders
- [ ] **Cross-workspace search** - Hledat napříč všemi workspace

---

#### 🟢 Workspace Diff

- [ ] **Compare workspace vs external** - Co jsi změnil oproti standardu
- [ ] **Conflict detection** - Najdi kolize mezi workspace a external
- [ ] **Merge suggestions** - Navrhni jak sloučit změny

---

#### 🟢 Advanced Pattern Matching

- [ ] **AST-based search** - Hledání podle struktury kódu, ne jen textu
- [ ] **Code clone detection** - Najdi duplicitní kód
- [ ] **Pattern templates** - Uživatelsky definované vzory

---

## 📋 Implementation Priority Order

1. **Editor Context Support** (🔴 Critical)
   - Bez toho nemůžeš analyzovat aktivně otevřený soubor
   - Největší user value

2. **Integrace do Všech Tools** (🔴 Critical)
   - `get_class_info`, `code_completion`, atd.
   - Musí být workspace-aware pro konzistenci

3. **XML Parsing ve Workspace** (🔴 Critical)
   - Aktuálně jen detekujeme soubory, ale nečteme metody/fields
   - Nutné pro správný IntelliSense

4. **Incremental Index** (🟡 Medium)
   - Performance optimization pro velké projekty
   - Lze použít i současnou implementaci

5. **Semantic Analysis** (🟡 Medium)
   - Nice to have, ale ne kritické

6. **Git Integration** (🟢 Low)
   - Bonus features

---

## 🎯 Doporučení: Začít S

### Fáze 1: Editor Context (1-2 dny)
```typescript
// Přidat do XppServerContext
editorContext?: EditorContext;

// Přidat do všech toolů parametr
useEditorContext?: boolean;
```

### Fáze 2: XML Parsing (2-3 dny)
```typescript
// Rozšířit WorkspaceScanner
async parseXmlFile(filePath: string): Promise<ParsedMetadata>

// ParsedMetadata obsahuje:
// - methods: { name, params, returnType, signature }
// - fields: { name, type, edt }
// - extends, implements
```

### Fáze 3: Tool Integration (1 den)
- Přidat `includeWorkspace` do každého toolu
- Upravit formátování výstupu (🔹 vs 📦)

### Fáze 4: Testing & Documentation (1 den)
- Unit testy pro workspace features
- Integration testy pro hybrid search
- Update dokumentace

---

## 💡 Poznámky

### Performance Consideration
- Workspace scan: ~100ms pro 100 souborů (s cachingem)
- XML parsing: +50ms per file (pokud použijeme)
- => Nutné cachovat agresivně!

### VS Code vs VS2022
- VS Code má lepší MCP support pro editor context
- VS2022 může mít omezené API pro cursor position
- Možná bude potřeba extension pro VS2022

### Security
- Workspace path musí být validován (path traversal attack)
- Limit na velikost workspace (max 10,000 souborů?)
- Rate limiting pro workspace scans

---

## 🚀 Quick Wins (Hotové za <1 hodinu)

1. ✅ ~~Přidat `includeWorkspace` do `get_class_info`~~ → Ještě TODO
2. ✅ ~~Přidat `includeWorkspace` do `code_completion`~~ → Ještě TODO  
3. ✅ ~~Ikony 🔹/📦 do všech tool outputs~~ → Hotovo v search
4. ⏳ **Přidat workspace stats do health endpoint** → 5 minut
5. ⏳ **Validace workspace path** → 10 minut
6. ⏳ **Error handling pro nedostupný workspace** → 15 minut

---

## 📝 Breaking Changes

⚠️ Žádné breaking changes zatím plánované - všechny workspace features jsou **opt-in** pomocí parametrů.

