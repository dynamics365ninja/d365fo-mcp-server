# MCP Nástroje pro D365FO/X++

Tento dokument popisuje všechny dostupné nástroje MCP serveru pro práci s D365 Finance & Operations a X++ kódem.

## 📚 Obsah

1. [Základní vyhledávací nástroje](#-základní-vyhledávací-nástroje)
2. [Detailní informace o objektech](#-detailní-informace-o-objektech)
3. [Inteligentní generování kódu](#-inteligentní-generování-kódu)
4. [Workspace-Aware Features](#-workspace-aware-features)
5. [Workflow pro tvorbu kódu](#-workflow-pro-tvorbu-kódu)

---

## 🔍 Základní vyhledávací nástroje

### `search`

**Účel:** Vyhledávání X++ tříd, tabulek, metod, polí, enumů a EDT podle jména nebo klíčového slova

**Kdy použít:**
- Hledáte konkrétní třídu jako `CustTable`, `SalesLine`
- Potřebujete najít metodu podle názvu
- Zjišťujete, jaké objekty jsou k dispozici v D365FO

**Parametry:**
- `query` (string) - vyhledávací dotaz (název třídy, metody, tabulky atd.)
- `types` (array, optional) - filtr podle typu symbolu: `class`, `table`, `method`, `field`, `enum`, `edt`
- `limit` (number, optional) - maximální počet výsledků (výchozí: 20)

**Příklady použití:**
```typescript
// Najít všechny třídy obsahující "dimension"
search("dimension", types=["class"], limit=10)

// Vyhledat tabulky s "sales" v názvu
search("sales", types=["table"])

// Obecné vyhledávání bez filtru
search("validate")
```

**Výstup:**
```
Found 10 matches:

[CLASS] DimensionAttributeValueSet
[CLASS] DimensionDefaultingService
[CLASS] DimensionHelper
...
```

---

### `batch_search` ⚡ NOVÝ

**Účel:** Paralelní spuštění více vyhledávání najednou pro rychlejší exploraci

**Kdy použít:**
- Potřebujete vyhledat několik nezávislých konceptů (dimension + ledger + financial)
- Chcete zrychlit explorační fázi (3x rychlejší než sekvenční vyhledávání)
- Uživatel říká "najdi X a Y a Z"

**Parametry:**
- `queries` (array) - pole vyhledávacích dotazů, každý s vlastními parametry:
  - `query` (string) - vyhledávací text
  - `type` (string, optional) - filtr typu
  - `limit` (number, optional) - max výsledků

**Příklad použití:**
```typescript
batch_search({
  queries: [
    { query: "dimension", type: "class", limit: 5 },
    { query: "helper", type: "class", limit: 5 },
    { query: "validation", type: "class", limit: 5 }
  ]
})
```

**Výhoda:** Jeden HTTP požadavek místo tří → rychlejší o 67%, celkem ~50ms vs ~150ms

---

### `search_extensions`

**Účel:** Vyhledávání pouze v custom/ISV modulech (vlastních rozšířeních)

**Kdy použít:**
- Chcete filtrovat pouze vlastní rozšíření
- Potřebujete odlišit Microsoft kód od custom kódu
- Hledáte třídy s určitým prefixem (ISV_, Custom_, Asl)

**Parametry:**
- `query` (string) - vyhledávací dotaz
- `prefix` (string, optional) - filtr podle extension prefixu
- `limit` (number, optional) - maximální počet výsledků (výchozí: 20)

**Příklad použití:**
```typescript
// Najít všechny custom třídy obsahující "helper"
search_extensions("helper", prefix="ISV_")

// Vyhledat všechny Asl rozšíření
search_extensions("dimension", prefix="Asl")
```

---

## 📋 Detailní informace o objektech

### `get_class_info` 🔹

**Účel:** Získání kompletních informací o X++ třídě včetně zdrojového kódu všech metod

**Co vrací:**
- Deklaraci třídy (abstract, final, modifikátory)
- Dědičnost (extends, implements)
- Seznam všech metod včetně zdrojového kódu
- Viditelnost metod (public/private/protected/internal)
- Dokumentaci (summary, parametry)
- Model a cestu k souboru

**Parametry:**
- `className` (string) - název X++ třídy
- `includeWorkspace` (boolean, optional) - hledat v workspace uživatele jako první (výchozí: false)
- `workspacePath` (string, optional) - cesta k workspace projektu

**Příklad použití:**
```typescript
// Základní použití
get_class_info("DimensionAttributeValueSet")

// Workspace-aware vyhledávání (preferuje lokální soubory)
get_class_info("MyCustomHelper", 
  includeWorkspace=true, 
  workspacePath="C:\\D365\\MyProject")
```

**Výstup:**
```markdown
# Class: DimensionAttributeValueSet

**Model:** ApplicationPlatform
**Extends:** Object
**Implements:** -

## Declaration
```xpp
public class DimensionAttributeValueSet extends Object
```

## Methods (15)

### public DimensionAttribute getDimensionAttribute()
- Returns the dimension attribute

```xpp
public DimensionAttribute getDimensionAttribute()
{
    return dimensionAttribute;
}
```
...
```

**🔹 Speciální funkce:**
- **Workspace-aware**: Může vyhledávat v lokálním workspace uživatele před externí metadata
- XML parsing lokálních souborů pro okamžitý přístup k lokálnímu kódu

---

### `get_table_info`

**Účel:** Získání kompletní struktury X++ tabulky

**Co vrací:**
- Seznam všech polí (název, typ, EDT, mandatory, label)
- Indexy (primární, clustered, unique)
- Relace/Foreign keys
- Metody tabulky
- Table Group, Label, System Fields

**Parametry:**
- `tableName` (string) - název X++ tabulky

**Příklad použití:**
```typescript
get_table_info("SalesTable")
get_table_info("CustTable")
```

**Výstup:**
```markdown
# Table: SalesTable

**Model:** ApplicationSuite
**Label:** Sales orders
**Table Group:** Main
**Primary Index:** SalesIdx
**Clustered Index:** SalesIdx

## Fields (85)

| Name | Type | EDT | Mandatory | Label |
|------|------|-----|-----------|-------|
| SalesId | String | SalesId | Yes | Sales order |
| CustAccount | String | CustAccount | Yes | Customer account |
| SalesStatus | Enum | SalesStatus | Yes | Status |
...

## Indexes (12)

- **SalesIdx**: [SalesId] (unique) (clustered)
- **CustIdx**: [CustAccount, SalesId]
...

## Relations (8)

- **CustTable** → CustTable (CustAccount = AccountNum)
...

## Methods (45)

- `void insert()`
- `void update()`
- `boolean validateWrite()`
...
```

---

### `code_completion` 🔍

**Účel:** IntelliSense-style dokončování – zobrazí všechny metody a pole dostupné na třídě/tabulce

**Kdy použít:**
- Objevujete, jaké metody jsou dostupné na objektu
- Potřebujete zjistit signaturu metody
- Hledáte pole tabulky s určitým prefixem

**Parametry:**
- `className` (string) - název třídy nebo tabulky
- `prefix` (string, optional) - filtr podle prefixu (výchozí: "" = všechny členy)
- `includeWorkspace` (boolean, optional) - zahrnout workspace soubory (výchozí: false)
- `workspacePath` (string, optional) - cesta k workspace

**Příklad použití:**
```typescript
// Zobrazit všechny metody třídy
code_completion(className="SalesTable")

// Najít metody začínající na "calc"
code_completion(className="SalesTable", prefix="calc")

// Workspace-aware completion
code_completion(
  className="MyCustomTable", 
  includeWorkspace=true,
  workspacePath="C:\\D365\\MyProject"
)
```

**Výstup:**
```json
[
  {
    "label": "calcTotalAmount",
    "kind": "method",
    "detail": "public Amount calcTotalAmount()",
    "documentation": "Calculates the total sales amount"
  },
  {
    "label": "calcTax",
    "kind": "method",
    "detail": "public TaxAmount calcTax()",
    "documentation": "Calculates tax for the order"
  }
]
```

**Speciální funkce:**
- Funguje pro třídy i tabulky
- Podporuje workspace-first search
- Prázdný prefix vrátí VŠECHNY dostupné členy

---

## ⚡ Inteligentní generování kódu

### `analyze_code_patterns` 🔴 POVINNÝ PRVNÍ KROK

**Účel:** Analýza existujících vzorů v kódbazi PŘED generováním jakéhokoli kódu

**⚠️ KRITICKÉ: Tento nástroj MUSÍTE volat před jakýmkoli generováním X++ kódu!**

**Proč je POVINNÝ:**
- Zjistí, jaké D365FO třídy a metody se běžně používají v projektu
- Identifikuje časté závislosti a API
- Najde příklady podobných implementací z reálného kódu
- Prevence použití obecných vzorů místo skutečného D365FO kódu z projektu
- Učí se z VAŠÍ kódbáze, ne z obecných příkladů

**Parametry:**
- `scenario` (string) - scénář nebo doména k analýze (např. "dimension", "validation", "customer")
- `classPattern` (string, optional) - filtr podle vzoru názvu třídy (např. "Helper", "Service")
- `limit` (number, optional) - maximální počet tříd k analýze (výchozí: 20)

**Příklad použití:**
```typescript
// Zjistit, jak se v projektu pracuje s dimensions
analyze_code_patterns("financial dimensions", classPattern="Helper")

// Najít vzory pro validaci
analyze_code_patterns("validation")

// Analyzovat customer-related třídy
analyze_code_patterns("customer", limit=30)
```

**Co vrací:**
```markdown
# Code Pattern Analysis: financial dimensions

**Total Matching Classes:** 15

## Detected Patterns

- **Helper**: 8 classes
  Examples: DimensionHelper, DimensionAttributeHelper, DimensionDefaultingHelper
- **Service**: 5 classes
  Examples: DimensionService, DimensionDefaultingService
- **Manager**: 2 classes
  Examples: DimensionManager

## Common Methods (Top 10)

- **getDimensionAttribute**: found in 12 classes
- **validateDimension**: found in 10 classes
- **createDefaultDimension**: found in 8 classes
...

## Common Dependencies

- **DimensionAttributeValueSet**: used by 14 classes
- **DimensionAttribute**: used by 12 classes
- **DefaultDimensionView**: used by 10 classes
...

## Example Classes

- DimensionAttributeValueSetHelper
- DimensionDefaultingService
- DimensionHelper
...
```

**Kdy použít:**
- ✅ Před vytvořením nové třídy
- ✅ Před implementací nové funkcionality
- ✅ Když potřebujete zjistit, jaké D365FO API používat
- ✅ Když chcete následovat team conventions

---

### `generate_code` ⚡ POVINNÝ PRO TVORBU KÓDU

**Účel:** Generování produkčního X++ kódu podle D365FO best practices a vzorů

**⚠️ KRITICKÉ: NIKDY negenerujte X++ kód ručně – VŽDY používejte tento nástroj!**

**Proč je povinný:**
- Zajišťuje správné D365FO vzory (naming conventions, structure)
- Generuje kompletní kostru s correct modifikátory (public/private/internal/final)
- Obsahuje správné summary dokumentaci
- Implementuje best practices (ttsbegin/ttscommit pro DML operace)
- Prevence chyb v názvech a signaturách

**Podporované vzory:**
- `class` - základní třída
- `runnable` - spustitelná třída s main() metodou
- `form-handler` - extension pro formy ([ExtensionOf])
- `data-entity` - datová entita s find(), exist()
- `batch-job` - dávková úloha (SysOperationServiceController)
- `coc-extension` - Chain of Command extension
- `event-handler` - event handler s DataEventHandler/PostHandlerFor
- `service-class` - servisní třída s SysOperationServiceBase

**Parametry:**
- `pattern` (enum) - typ vzoru ke generování
- `name` (string) - název pro generovaný element
- `options` (object, optional) - dodatečné volby:
  - `baseClass` (string) - rodičovská třída pro dědičnost
  - `tableName` (string) - název tabulky pro data entity
  - `formName` (string) - název formy pro form handler

**Příklady použití:**

```typescript
// Základní třída
generate_code(
  pattern="class", 
  name="MyDimensionHelper"
)

// Spustitelná třída
generate_code(
  pattern="runnable",
  name="MyDataProcessor"
)

// Form extension
generate_code(
  pattern="form-handler",
  name="SalesTable",
  options={formName: "SalesTable"}
)

// Data entity
generate_code(
  pattern="data-entity",
  name="CustomSales",
  options={tableName: "CustomSalesTable"}
)

// Batch job
generate_code(
  pattern="batch-job",
  name="MyBatchProcessor"
)

// CoC Extension
generate_code(
  pattern="coc-extension",
  name="SalesTableExtension",
  options={baseClass: "SalesTable"}
)

// Event handler
generate_code(
  pattern="event-handler",
  name="CustTableEvent",
  options={tableName: "CustTable"}
)
```

**Výstup příklad (runnable):**
```xpp
/// <summary>
/// Runnable class MyDataProcessor
/// </summary>
internal final class MyDataProcessor
{
    /// <summary>
    /// Main entry point for the runnable class
    /// </summary>
    /// <param name="_args">Arguments passed to the class</param>
    public static void main(Args _args)
    {
        MyDataProcessor instance = new MyDataProcessor();
        instance.run();
    }

    /// <summary>
    /// Executes the business logic
    /// </summary>
    public void run()
    {
        // TODO: Implement business logic
        info("MyDataProcessor executed successfully");
    }
}
```

---

### `suggest_method_implementation`

**Účel:** Návrh implementace konkrétní metody na základě podobných metod v kódbazi

**Kdy použít:**
- Potřebujete implementovat metodu jako validate(), find(), create()
- Chcete vidět, jak podobné metody jsou implementovány v projektu
- Hledáte správný vzor pro konkrétní typ metody

**Parametry:**
- `className` (string) - název třídy obsahující metodu
- `methodName` (string) - název metody k návrhu implementace
- `parameters` (array, optional) - parametry metody [{name, type}]
- `returnType` (string, optional) - návratový typ (výchozí: "void")

**Příklad použití:**
```typescript
// Návrh implementace validate metody
suggest_method_implementation(
  className="MyHelper",
  methodName="validate",
  parameters=[{name: "record", type: "Common"}],
  returnType="boolean"
)

// Návrh create metody
suggest_method_implementation(
  className="MyManager",
  methodName="createRecord",
  returnType="RecId"
)
```

**Co dělá:**
1. Najde podobné metody podle názvu v celé kódbazi
2. Zobrazí jejich implementaci se zdrojovým kódem
3. Analyzuje složitost a použité tagy
4. Navrhne vzor na základě reálného kódu

**Výstup:**
```markdown
# Method Implementation Suggestions

**Class:** MyHelper
**Method:** boolean validate(Common record)

## Similar Methods Found

### 1. DimensionHelper.validateDimension

**Signature:** `boolean validateDimension(Common _record)`
**Complexity:** Medium
**Tags:** validation, dimension, check

**Implementation Preview:**

```xpp
boolean validateDimension(Common _record)
{
    boolean isValid = true;
    
    if (!_record)
    {
        isValid = false;
        error("Record cannot be null");
    }
    
    // Additional validation logic
    
    return isValid;
}
```

### 2. SalesTableHelper.validateRecord
...

## Suggested Implementation Pattern

```xpp
public boolean validate(Common _record)
{
    boolean isValid = true;
    
    // Add validation logic here
    
    return isValid;
}
```
```

---

### `analyze_class_completeness`

**Účel:** Kontrola, zda třídě nechybí běžné metody podle vzorů v kódbazi

**Kdy použít:**
- Po vytvoření nové třídy
- Chcete zajistit, že třída následuje team conventions
- Hledáte, jaké metody často chybí v podobných třídách

**Parametry:**
- `className` (string) - název třídy k analýze

**Příklad použití:**
```typescript
analyze_class_completeness("MyCustomHelper")
```

**Co dělá:**
1. Najde typ vzoru třídy (Helper, Service, Manager atd.)
2. Porovná s podobnými třídami v kódbazi
3. Identifikuje běžné metody, které chybí
4. Zobrazí frekvenci výskytu každé metody

**Výstup:**
```markdown
# Class Completeness Analysis: MyCustomHelper

**Model:** MyModel
**Pattern Type:** Helper
**Existing Methods:** 3

## Implemented Methods

- `void init()`
- `boolean validate()`
- `void run()`

## Suggested Missing Methods

Based on analysis of similar Helper classes:

- **find**: Found in 85% of similar classes (17/20)
- **exist**: Found in 75% of similar classes (15/20)
- **create**: Found in 70% of similar classes (14/20)
- **delete**: Found in 60% of similar classes (12/20)
- **update**: Found in 55% of similar classes (11/20)

**Recommendation:** Consider implementing these methods to follow common patterns in your codebase.
```

---

### `get_api_usage_patterns`

**Účel:** Zjištění, jak se používá konkrétní API nebo třída v celé kódbazi

**Kdy použít:**
- Potřebujete použít D365FO API, ale nejste si jisti, jak ho inicializovat
- Hledáte správnou sekvenci volání metod
- Chcete vidět reálné příklady použití z projektu

**Parametry:**
- `className` (string) - název třídy/API k získání usage patterns

**Příklad použití:**
```typescript
get_api_usage_patterns("DimensionAttributeValueSet")
get_api_usage_patterns("NumberSeq")
```

**Co vrací:**
- Počet použití v kódbazi
- Nejčastější volání metod (seřazené podle frekvence)
- Běžné inicializační vzory (code snippets)
- Seznam tříd, kde se API používá
- Doporučený usage flow

**Výstup:**
```markdown
# API Usage Patterns: DimensionAttributeValueSet

**Usage Count:** 142 places in codebase

## Most Common Method Calls

- **getDimensionAttribute**: called 89 times
- **validateValue**: called 67 times
- **setValue**: called 54 times
- **getValue**: called 51 times
- **save**: called 45 times

## Common Initialization Patterns

### Pattern 1

```xpp
DimensionAttributeValueSet dimAttrValueSet;
DimensionAttribute dimAttr;

dimAttr = DimensionAttribute::findByName("Department");
dimAttrValueSet = new DimensionAttributeValueSet();
dimAttrValueSet.parmDimensionAttribute(dimAttr);
```

### Pattern 2

```xpp
DimensionAttributeValueSet dimAttrValueSet;

dimAttrValueSet = DimensionAttributeValueSet::find(recId);
if (dimAttrValueSet)
{
    dimAttrValueSet.setValue("Value");
    dimAttrValueSet.save();
}
```

## Used In Classes

- DimensionDefaultingService
- DimensionHelper
- LedgerDimensionFacade
- FinancialDimensionManager
...

## Usage Recommendation

Based on codebase analysis, the typical usage flow is:
1. Initialize DimensionAttributeValueSet
2. Call getDimensionAttribute()
3. Call setValue()
4. Call validateValue()
5. Call save()
```

---

## 🔹 Workspace-Aware Features

Některé nástroje podporují vyhledávání v lokálním workspace uživatele s prioritou před externí metadata.

### Co jsou Workspace-Aware Features?

**Workspace-aware** nástroje mohou:
- Vyhledávat v lokálních X++ souborech uživatele (*.xml)
- Parsovat XML metadata přímo z workspace
- Preferovat lokální soubory před externí databází
- Zobrazit aktuální stav kódu v projektu uživatele

### Podporované nástroje

| Nástroj | Workspace Support | Popis |
|---------|-------------------|--------|
| `search` | ✅ Ano | Vyhledává v workspace + externí metadata |
| `get_class_info` | ✅ Ano | Preferuje lokální soubory před AOT |
| `code_completion` | ✅ Ano | Zobrazí metody z lokálních XML souborů |
| `get_table_info` | ❌ Ne | Pouze externí metadata |

### Jak používat Workspace-Aware vyhledávání

**Parametry:**
- `includeWorkspace` (boolean) - zapne workspace-aware search
- `workspacePath` (string) - absolutní cesta k D365FO workspace projektu

**Příklad:**
```typescript
// Standardní vyhledávání (jen externí metadata)
get_class_info("MyClass")

// Workspace-aware vyhledávání (lokální + externí)
get_class_info(
  "MyClass",
  includeWorkspace=true,
  workspacePath="C:\\Users\\MyUser\\D365\\MyProject"
)
```

### Značení výsledků

Výsledky jsou označeny podle zdroje:

- 🔹 = **Soubor z workspace** (lokální projekt uživatele)
- 📦 = **Externí metadata** (z centrální databáze)

### Výhody Workspace-Aware vyhledávání

1. **Priorita lokálního kódu**: Vidíte aktuální stav vašeho kódu
2. **Rychlejší iterace**: Okamžitý přístup k lokálním změnám
3. **Skutečné implementace**: Ne cached verze, ale reálný kód
4. **Deduplication**: Workspace soubory mají prioritu, duplikáty z external se ignorují

### XML Parsing

MCP server umí parsovat tyto X++ XML soubory:
- AxClass - třídy s metodami
- AxTable - tabulky s poli a metodami
- AxForm - formuláře
- AxDataEntity - datové entity

**Co se extrahuje:**
- Metody (název, návratový typ, parametry, viditelnost)
- Pole (název, typ, label, mandatory)
- Dokumentace (summary tags)
- Relationships a indexy

---

## 🎯 Workflow pro tvorbu kódu

### ✅ SPRÁVNÝ POSTUP

Když uživatel řekne: **"Vytvoř helper třídu pro práci s financial dimensions"**

```typescript
// Krok 1: POVINNÝ - Analyzuj existující vzory
analyze_code_patterns("financial dimensions", classPattern="Helper")
// → Zjistím: Používají se DimensionAttributeValueSet, DimensionAttribute, 
//            běžné metody jsou validateDimension(), createDefault()

// Krok 2: Získej informace o klíčovém API
get_class_info("DimensionAttributeValueSet")
// → Pochopím strukturu API, jaké metody má

// Krok 3: Zjisti usage patterns
get_api_usage_patterns("DimensionAttributeValueSet")
// → Zjistím správnou inicializaci a usage flow

// Krok 4: Vygeneruj kostru třídy
generate_code(pattern="class", name="MyDimensionHelper")
// → Získám správně strukturovanou třídu

// Krok 5: Implementuj metody podle patterns
suggest_method_implementation("MyDimensionHelper", "validateDimension")
// → Získám příklady implementace z reálného kódu

// Krok 6: Zkontroluj completeness
analyze_class_completeness("MyDimensionHelper")
// → Zjistím, jaké metody ještě běžně chybí
```

### ❌ ŠPATNÝ POSTUP

**NIKDY:**
```xpp
// ❌ ŠPATNĚ - Generování kódu přímo bez nástrojů!
public class MyDimensionHelper {
    // ... 
}
```

**Proč je to špatně:**
- Používáte obecné znalosti místo reálného kódu z projektu
- Nesledujete team conventions
- Nevíte, jaké D365FO API se v projektu používá
- Chybí správné modifikátory a dokumentace
- Nepoužíváte best practices z kódbáze

### Pravidla pro AI asistenty

**POVINNÁ PRAVIDLA:**

1. ✅ **VŽDY** volejte `analyze_code_patterns` PŘED generováním kódu
2. ✅ **VŽDY** používejte `generate_code` nástroj, NIKDY negenerujte X++ kód ručně
3. ✅ **VŽDY** používejte workspace-aware search když je workspace dostupný
4. ✅ **VŽDY** používejte `batch_search` pro více nezávislých queries
5. ❌ **NIKDY** nepoužívejte built-in `code_search` - způsobuje timeout!
6. ❌ **NIKDY** negenerujte X++ kód přímo z generic knowledge

### Decision Tree pro výběr nástroje

| Požadavek uživatele | První akce | Vyhněte se |
|---------------------|------------|------------|
| "create class", "helper class" | `analyze_code_patterns()` + `generate_code()` | ❌ přímé generování kódu |
| "find X and Y and Z" | `batch_search([{query:"X"}, {query:"Y"}])` | ❌ 3x sekvenční search |
| "CustTable", "SalesTable" | `get_table_info()` | ❌ code_search |
| "dimension", "financial" | `search("dimension")` | ❌ code_search |
| "find class/method" | `search()` | ❌ code_search |
| "implement method" | `suggest_method_implementation()` | ❌ generic code |

---

## 📊 Performance Metriky

### Rychlost nástrojů

| Nástroj | Typická rychlost | Cache |
|---------|------------------|-------|
| `search` | < 10ms | ✅ SQLite index |
| `batch_search` | ~50ms (3 queries) | ✅ Paralelní |
| `get_class_info` | < 5ms (cached) | ✅ File cache |
| `get_table_info` | < 5ms (cached) | ✅ File cache |
| `code_completion` | < 10ms | ✅ Prepared statements |
| `generate_code` | < 1ms | ❌ Template-based |
| `analyze_code_patterns` | 50-200ms | ⚠️ Částečně cachováno |

### Database optimalizace

MCP server používá:
- **SQLite s FTS5** - full-text search index pro rychlé vyhledávání
- **WAL journal mode** - Write-Ahead Logging pro paralelní čtení
- **Prepared statements** - cachované SQL dotazy
- **Single transaction** - bulk insert během indexování

---

## 🔧 Troubleshooting

### Časté problémy

**1. Nástroj vrací "Not found"**
```typescript
// Problém: Class "MyClass" not found
get_class_info("MyClass")

// Řešení: Zkontrolujte překlepy, použijte search první
search("MyClass")
```

**2. Workspace soubory se nenačítají**
```typescript
// Problém: includeWorkspace=true nefunguje

// Zkontrolujte:
// - Je workspacePath správně nastavená?
// - Jsou v cestě XML soubory?
// - Máte oprávnění číst soubory?
```

**3. Timeout při vyhledávání**
```typescript
// ❌ NIKDY nepoužívejte built-in code_search!
// Používá grep na velkých workspace → timeout 5+ minut

// ✅ Místo toho:
search("myQuery")  // MCP nástroj - SQL index, < 10ms
```

**4. Chybějící metody v completion**
```typescript
// Problém: code_completion vrací prázdný seznam

// Možné příčiny:
// - Třída nemá veřejné metody
// - Špatný název třídy (překlep)
// - Třída není v indexu

// Řešení: Zkontrolujte existenci třídy
search("MyClass", types=["class"])
```

---

## 📚 Další zdroje

- [WORKSPACE_AWARE.md](./WORKSPACE_AWARE.md) - Detaily o workspace-aware features
- [USAGE_EXAMPLES.md](./USAGE_EXAMPLES.md) - Více příkladů použití
- [SYSTEM_INSTRUCTIONS.md](./SYSTEM_INSTRUCTIONS.md) - Instrukce pro AI orchestrator
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Architektura MCP serveru

---

**Poslední aktualizace:** 12. února 2026
