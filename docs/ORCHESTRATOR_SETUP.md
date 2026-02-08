# Jak nastavit GitHub Copilot ve Visual Studio 2022 pro použití X++ MCP Tools

Tento průvodce vysvětluje, jak nastavit GitHub Copilot ve Visual Studio 2022, aby používal vaše X++ MCP tools pro D365 Finance & Operations development.

## Řešení: System Instructions Prompt

Vytvořili jsme speciální MCP prompt nazvaný **`xpp_system_instructions`**, který instruuje GitHub Copilot, jak správně používat X++ tools při vývoji D365 F&O.

## Požadavky

| Komponenta | Verze | Poznámka |
|-----------|-------|----------|
| Visual Studio 2022 | 17.14+ | Vyžadováno pro MCP podporu |
| GitHub Copilot Extension | Nejnovější | Enterprise nebo Individual předplatné |
| GitHub Copilot Chat | Nejnovější | Agent Mode povolen |
| D365 F&O Dev Tools | Nejnovější | Pro X++ development |

## Nastavení

## Nastavení

### Krok 1: Povolit MCP v GitHub účtu

Přejděte na **GitHub account settings** a zapněte Editor Preview Features:

👉 https://github.com/settings/copilot/features

> ⚠️ **Důležité:** Bez tohoto nastavení se MCP tools nenačtou v GitHub Copilot!

### Krok 2: Povolit MCP v Visual Studio 2022

1. Otevřete **Tools** → **Options** → **GitHub** → **Copilot**
2. Zaškrtněte: ✅ *"Enable MCP server integration in agent mode"*
3. Klikněte **OK**

### Krok 3: Vytvořit `.mcp.json` konfiguraci

V kořenové složce vašeho D365 F&O solution vytvořte soubor `.mcp.json`:

```json
{
  "servers": {
    "d365fo-code-intelligence": {
      "url": "https://your-app.azurewebsites.net/mcp/",
      "description": "D365 F&O X++ Code Intelligence Server"
    }
  }
}
```

**Poznámky:**
- Pro **cloud deployment**: Použijte URL vašeho Azure App Service
- Pro **local development**: Použijte `http://localhost:8080/mcp/`

#### Příklad pro local development:

```json
{Použití v Visual Studio 2022

### Automatické použití system instructions

Gi Co system instructions dělají

### ✅ VŽDY POUŽÍT tyto X++ MCP tools při práci s D365 F&O:na X++ MCP tools. Není potřeba manuálně volat prompt.

### Příklady dotazů v Copilot Chat

Jednoduše pokládejte otázky v přirozeném jazyce:

```
💬 "Show me all methods on the InventTable class"

💬 "What fields does CustTable have?"

💬 "Generate a batch job class for processing sales orders"

💬 "Find all custom extensions in my ISV module"

💬 "Help me extend SalesTable validation"
```

GitHub Copilot automaticky:
1. Rozpozná, že jde o D365 F&O dotaz
2. Použije příslušný MCP tool (`get_class_info`, `get_table_info`, atd.)
3. Vrátí přesné informace z vašich metadat
4. Vygeneruje kód podle D365 F&O best practices
      "url": "http://localhost:8080/mcp/",
      "description": "D365 F&O X++ Local Development Server"
    }
  }
}
``` pro D365 F&O

### Krok 4: Restartovat Visual Studio

Restartujte Visual Studio 2022, aby se načetla nová konfigurace.

### Krok 5: Ověřit f ve Visual Studio 2022

### Příklad 1: Přidání metody do existující třídy

**Developer v Copilot Chatište: `@workspace /tools`
4. Měli byste vidět vaše X++ MCP tools v seznamu
GitHub Copilot provede:**
```
1. get_class_info("CustTable") → zjistí strukturu třídy z AOT metadat
2. code_completion("CustTable") → zjistí dostupné API metody
3. Vygeneruje Chain of Command extension class
4. Použije správné X++ konvence a D365 F&O best practices
```

### Příklad 2: Psaní query kódu

**Developer v Copilot Chat:** "Dotaz na všechny zákazníky s balance > 1000"

**GitHub Copilot provede:**
```
1. get_table_info("CustTable") → zjistí přesné názvy polí z AOT
2. search("balance", type="field") → najde přesný název pole
3. Zkontroluje indexy pro performance optimalizaci
4. Vygeneruje optimalizovaný X++ query s správnými field names
```

### Příklad 3: Extension standardního kódu

**Developer v Copilot Chat:** "Extenduj SalesTable validaci"

**GitHub Copilot provede:**
```
1. get_class_info("SalesTable") → najde validační metody v metadatech
2. code_completion("SalesTable", "validate") → zjistí přesné method signatures
3. Vygeneruje Chain of Command extension třídu
4. Použije správné X++ extension patterns pro D365 F&O Cloud
```

## Podporované workflow

| Workflow | Jak pomáhá |
|----------|------------|
| **Code Navigation** | Okamžitě najde classes, methods a tables bez browsování AOT |
| **Code Completion** | Přesné method signatures a field names z vašich metadat |
| **Code Generation** | Generuje boilerplate X++ kód podle D365 F&O best practices |
| **Code Review** | Analyzuje existující kód s plným metadata contextem |
| **Learning** | Prozkoumává neznámé moduly pomocí natural language dotazů |
| **Extension Development** | Najde extension points a vygeneruje Chain of Command extensions |

## Dostupné MCP tools

Kompletní seznam tools dostupných v GitHub Copilot:

| Tool | Popis | Příklad použití |
|------|-------|-----------------|
| `search` | Hledá X++ classes, tables, methods, fields | "Find all classes with 'Sales' in name" |
| `search_extensions` | Hledá pouze custom/ISV extensions | "Show my custom extensions" |
| `get_class_info` | Detailní info o třídě včetně metod | "What methods does CustTable have?" |
| `get_table_info` | Detailní info o tabulce, fieldy, indexy | "Show CustTable structure" |
| `code_completion` | IntelliSense pro methods a fields | "What can I call on SalesLine?" |
| `generate_code` | Generuje X++ šablony | "Generate batch job template" |

## Dostupné prompts

Seznam všech dostupných promptů pro code review a best practices:

```bash
# Zobrazit všechny prompty (z terminálu nebo PowerShell)
curl http://localhost:8080/prompts/list
```

Dostupné prompty:
- **`xpp_system_instructions`** - System instrukce pro GitHub Copilot (automaticky použité)
- **`xpp_code_review`** - Review X++ kódu na best practices
- **`xpp_explain_class`** - Detailní vysvětlení X++ třídy
- **`xpp_refactor_code`** - Návrhy na refactoring kódu
- **`xpp_best_practices`** - Best practices pro různá témata (transactions, error handling, atd.)

## Testování v Visual Studio

### Test 1: Ověření načtení tools

1. Otevřete GitHub Copilot Chat
2. Zapněte Agent Mode
3. Napište: `@workspace /tools`
4. Ověřte, že vidíte: `search`, `get_class_info`, `get_table_info`, atd.

### Test 2: Test funkčnosti

V Copilot Chat zkuste:

```
What methods are available on InventTable class?
```

Copilot by měl:
1. Zavolat `get_class_info("InventTable")`
2. Vrátit seznam metod z vašich metadat
3. Zobrazit method signatures a popis

### Test 3: Code generation

V Copilot Chat zkuste:

```
Generate a runnable class that queries CustTable for customers with CreditMax > 10000
```

Copilot by měl:
1. Zavolat `get_table_info("CustTable")` pro zjištění field names
2. Zavolat `generate_code` pro batch job template
3. Vygenerovat kompletní X++ kód s správnými field names

## Troubleshooting

### Tools se nenačítají

**Problém:** MCP tools nejsou viditelné v Copilot Chat

**Řešení:**
1. Ověřte, že máte povoleny **Editor Preview Features** na GitHub
2. Zkontrolujte **Tools → Options → GitHub → Copilot** v VS 2022
3. Ověřte syntaxi `.mcp.json` souboru (použijte JSON validator)
4. Restartujte Visual Studio úplně (zavřete všechna okna)

### MCP server neodpovídá

**Problém:** Tools jsou viditelné, ale nevrací data

**Řešení:**
1. Pro **local**: Ověřte, že server běží (`npm run dev`)
2. Pro **cloud**: Zkontrolujte, že Azure App Service je spuštěný
3. Zkontrolujte síťové připojení a firewall
4. Zkontrolujte logy serveru pro chyby

### Copilot nepoužívá tools automaticky

**Problém:** Copilot generuje kód, ale nepoužívá MCP tools

**Řešení:**
1. Explicitně požádejte: "Use get_class_info to check CustTable methods"
2. Použijte Agent Mode (@workspace) pro lepší tool detection
3. Restartujte konverzaci v Copilot Chat
4. Ověřte, že system instructions prompt existuje (`xpp_system_instructions`)

### Prázdné výsledky z tools

**Problém:** Tools vrací prázdné výsledky nebo "not found"

**Řešení:**
1. Ověřte, že máte stažená metadata: `npm run build:db`
2. Zkontrolujte připojení k Redis cache (pokud používáte)
3. Zkuste širší search s `type='all'`
4. Zkontrolujte spelling názvu objektu (case-sensitive)

## Optimalizace pro ISV/Partner scénáře

Pokud vyvíjíte custom extensions nebo pracujete jako ISV partner:

### Konfigurace custom models

V `.env` souboru MCP serveru:

```env
# Custom Extensions (ISV scenarios)
CUSTOM_MODELS=ISV_YourCompany,Custom_Module1,Custom_Module2
EXTENSION_PREFIX=ISV_,CUS_
```

### Použití search_extensions

Pro hledání pouze vašeho custom kódu:

```
💬 "Find all my custom ISV extensions for CustTable"
```

Copilot použije `search_extensions` místo `search`, takže neuvidíte standardní Microsoft objekty.

## Performance tipy

1. **První query je pomalejší** (~50ms) - následující jsou cachované (<10ms)
2. **Redis cache** - Zapněte pro produkci pro nejlepší performance
3. **Batch queries** - Copilot může volat několik tools najednou
4. **Metadata sync** - Pravidelně aktualizujte metadata z PackagesLocalDirectory

## Bezpečnost

### Cloud deployment (Azure)

- Použijte **Azure App Service** s authentication
- Zapněte **Managed Identity** pro Blob Storage
- Nastavte **IP restrictions** pokud potřeba
- Použijte **Azure Cache for Redis** s SSL

### On-premise deployment

- Omezit přístup na **internal network only**
- Použít **reverse proxy** (nginx/IIS) s authentication
- Pravidelná **backup metadat**

## Související dokumentace

- [SETUP.md](./SETUP.md) - Úvodní nastavení MCP serveru
- [USAGE_EXAMPLES.md](./USAGE_EXAMPLES.md) - Příklady použití tools
- [TESTING.md](./TESTING.md) - Testování MCP serveru
- [CUSTOM_EXTENSIONS.md](./CUSTOM_EXTENSIONS.md) - ISV extension konfigurace
- [PERFORMANCE.md](./PERFORMANCE.md) - Performance optimalizace
- [README.md](../README.md) - Hlavní dokumentace

## Shrnutí

✅ **MCP server + GitHub Copilot + Visual Studio 2022 = Powerful X++ development**

System instructions automaticky řídí GitHub Copilot k použití vašich X++ MCP tools, což poskytuje:
- 🎯 **Přesné code completion** z real-time metadat
- ⚡ **Rychlé vyhledávání** v 500k+ symbolech
- 🔧 **D365 F&O best practices** při generování kódu
- 🚀 **Produktivnější development** bez browsování AOT
1. **Vždy načtěte system instructions na začátku** - Ideálně jako první věc v konverzaci
2. **Můžete je kombinovat** - System instructions + code review najednou
3. **Pro nové projekty** - Nastavte jako default v konfiguraci IDE/editoru
4. **Redis caching** - Tools jsou rychlé díky cachingu, nebojte se jich používat často

## Troubleshooting

**Problém:** AI stále nepoužívá tools

**Řešení:** 
- Ověřte, že máte načtený `@xpp_system_instructions` prompt
- Zkuste explicitně požádat: "Prosím použij get_class_info pro zjištění struktury CustTable"
- Restartujte MCP server

**Problém:** Tools vracejí prázdné výsledky

**Řešení:**
- Zkontrolujte, že máte stažená metadata (`npm run build:db`)
- Ověřte připojení k Redis cache
- Použijte `search` s type='all' pro širší výsledky

## Související

- [USAGE_EXAMPLES.md](./USAGE_EXAMPLES.md) - Příklady použití
- [SETUP.md](./SETUP.md) - Úvodní nastavení
- [TESTING.md](./TESTING.md) - Testování MCP serveru
