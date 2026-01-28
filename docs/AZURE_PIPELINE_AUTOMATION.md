# Automatizace Extrakce Metadat s Azure Pipeline

Tento dokument popisuje řešení pro automatizovanou extrakci X++ metadat s oddělením standard a custom modelů pro optimalizaci výpočetního času.

## Přehled Řešení

### Problém
- **Standard metadata** se mění párkrát do roka
- **Custom metadata** se mohou měnit na denní bázi
- Plná extrakce všech modelů trvá dlouho a není efektivní pro denní aktualizace

### Řešení
Oddělená správa metadat v Azure Blob Storage:
```
/metadata/standard/    # Standard D365 modely (aktualizace párkrát ročně)
/metadata/custom/      # Custom/ISV modely (denní aktualizace)
/databases/            # Zkompilovaná SQLite databáze
```

## Architektura

```
DevOps Git Repository (D365FO Source Code)
    ↓
Azure Pipeline (Extract Custom Models Only)
    ↓
Azure Blob Storage
    ├── /metadata/standard/  [Cached, statické]
    ├── /metadata/custom/    [Daily updates]
    └── /databases/xpp-metadata-latest.db
    ↓
Azure App Service (MCP Server)
```

## Komponenty Řešení

### 1. Azure Blob Manager (`scripts/azure-blob-manager.ts`)

Nový TypeScript skript pro správu metadat v Azure Blob Storage.

**Funkce:**
- `upload-standard` - Upload standard metadat
- `upload-custom` - Upload custom metadat
- `upload-all` - Upload všech metadat
- `download-standard` - Download standard metadat (pro build)
- `download-custom` - Download custom metadat
- `download-all` - Download všech metadat
- `delete-custom` - Smazání custom metadat z blobu
- `delete-local-custom` - Smazání lokálních custom metadat
- `upload-database` - Upload zkompilované databáze
- `download-database` - Download databáze

**Použití:**
```bash
npm run blob-manager upload-custom
npm run blob-manager delete-custom Model1,Model2
npm run blob-manager download-standard
npm run blob-manager upload-database ./data/xpp-metadata.db
```

### 2. Azure Pipeline - Denní Aktualizace (`azure-pipelines-quick.yml`)

Optimalizovaná pipeline pro rychlé denní aktualizace custom modelů.

**Fáze:**
1. **Download Standard Metadata** - Stažení cachovaných standard metadat
2. **Delete Old Custom** - Smazání starých custom metadat
3. **Extract Custom** - Extrakce pouze custom modelů z Git
4. **Build Database** - Sestavení databáze (standard + nové custom)
5. **Upload** - Upload custom metadat a databáze do blobu
6. **Restart App Service** - Restart MCP serveru

**Scheduler:**
- Běží každý den v 2:00 UTC
- Zpracovává pouze custom modely
- Trvá ~5-15 minut místo hodin

### 3. Azure Pipeline - Plná Extrakce (`azure-pipelines.yml`)

Kompletní pipeline pro periodickou aktualizaci všech modelů.

**Použití:**
- Při změně standard D365 modelů (upgrade, hotfix)
- Manuální spuštění podle potřeby
- ~Párkrát ročně

## Konfigurace

### Environment Variables

V `.env` nebo Azure DevOps Variable Groups:

```env
# Azure Blob Storage
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;...
BLOB_CONTAINER_NAME=xpp-metadata

# Metadata Paths
METADATA_PATH=./extracted-metadata
DB_PATH=./data/xpp-metadata.db

# Custom Models Configuration
CUSTOM_MODELS=ISV_Module1,ISV_Module2,CustomExtensions
EXTENSION_PREFIX=ISV_
EXTRACT_MODE=custom  # Options: all, standard, custom

# D365 Source (DevOps Git)
PACKAGES_PATH=/path/to/d365fo/source
```

### Azure DevOps Variable Group

Vytvořte Variable Group `xpp-mcp-server-config`:

| Variable | Value | Secret |
|----------|-------|--------|
| AZURE_STORAGE_CONNECTION_STRING | `DefaultEndpoints...` | ✅ |
| BLOB_CONTAINER_NAME | `xpp-metadata` | ❌ |
| CUSTOM_MODELS | `ISV_Module1,ISV_Module2` | ❌ |
| EXTENSION_PREFIX | `ISV_` | ❌ |
| AZURE_SUBSCRIPTION | `Your Azure Subscription` | ❌ |
| AZURE_APP_SERVICE_NAME | `your-mcp-server` | ❌ |

## Workflow Scénáře

### Scénář 1: Denní Aktualizace Custom Modelů

**Trigger:** Automatický (2:00 UTC každý den) nebo manuální

**Proces:**
1. Pipeline se spustí
2. Stáhne standard metadata z blobu (cache, rychlé)
3. Smaže staré custom metadata z blobu
4. Extrahuje custom modely z DevOps Git
5. Sestaví databázi (standard + nové custom)
6. Upload do blobu
7. Restart App Service

**Čas:** ~5-15 minut

**Příkazy:**
```bash
# Manuální spuštění
az pipelines run --name "Quick Custom Update"
```

### Scénář 2: Update Standard Modelů (Upgrade D365)

**Trigger:** Manuální po D365 upgrade

**Proces:**
1. Spuštění full pipeline s parametrem `extractionMode=all`
2. Extrakce všech modelů (standard + custom)
3. Upload všeho do blobu
4. Rebuild databáze

**Čas:** ~1-3 hodiny (závisí na počtu modelů)

**Příkazy:**
```bash
# Manuální spuštění
az pipelines run --name "Full Metadata Rebuild" --parameters extractionMode=all
```

### Scénář 3: Update Specifických Custom Modelů

**Trigger:** Manuální s parametry

**Proces:**
1. Spuštění s parametrem `customModels=Model1,Model2`
2. Extrakce pouze uvedených modelů
3. Upload do blobu

**Příkazy:**
```bash
az pipelines run --name "Quick Custom Update" --parameters customModels=ISV_Module1,ISV_Module2
```

## Struktura Azure Blob Storage

```
xpp-metadata/
├── metadata/
│   ├── standard/
│   │   ├── ApplicationFoundation/
│   │   │   ├── classes/
│   │   │   │   ├── SysClass1.json
│   │   │   │   └── ...
│   │   │   ├── tables/
│   │   │   │   ├── SysTable1.json
│   │   │   │   └── ...
│   │   │   └── enums/
│   │   ├── ApplicationPlatform/
│   │   ├── ApplicationSuite/
│   │   └── ... (všechny standard modely)
│   └── custom/
│       ├── ISV_Module1/
│       │   ├── classes/
│       │   ├── tables/
│       │   └── enums/
│       ├── ISV_Module2/
│       └── ... (custom modely)
└── databases/
    └── xpp-metadata-latest.db
```

## Monitoring a Troubleshooting

### Pipeline Logy

Každá fáze pipeline loguje:
- Počet zpracovaných souborů
- Počet extrahovaných classes/tables/enums
- Chyby při parsování
- Čas trvání

### Kontrola Blob Storage

```bash
# List all metadata
az storage blob list --account-name <account> --container-name xpp-metadata --prefix metadata/

# Check database
az storage blob show --account-name <account> --container-name xpp-metadata --name databases/xpp-metadata-latest.db

# Download for local testing
npm run blob-manager download-all
npm run build-database
```

### Lokální Testování

```bash
# 1. Download standard metadata
npm run blob-manager download-standard

# 2. Extract custom models locally
EXTRACT_MODE=custom CUSTOM_MODELS=ISV_Module1 npm run extract-metadata

# 3. Build database
npm run build-database

# 4. Test upload
npm run blob-manager upload-custom
npm run blob-manager upload-database ./data/xpp-metadata.db
```

## Optimalizace Výkonu

### Čas Úspory

| Operace | Před optimalizací | Po optimalizaci | Úspora |
|---------|------------------|-----------------|---------|
| Denní update | 2-3 hodiny | 5-15 minut | ~95% |
| Standard update | 2-3 hodiny | 2-3 hodiny | 0% (párkrát ročně) |
| Build databáze | 10-20 minut | 5-10 minut | ~50% |

### Tipy

1. **Cache Standard Metadata**: Nikdy nesmazat, pouze refresh při D365 upgrade
2. **Inkrementální Custom**: Pouze changed custom modely
3. **Paralelní Processing**: Pipeline používá artifacts pro paralelizaci
4. **Redis Cache**: Optional, ale doporučené pro produkci

## Náklady

### Azure Resources

| Resource | Configuration | Monthly Cost |
|----------|---------------|--------------|
| Blob Storage | 500 MB (standard) + 50 MB (custom) | ~$1-2 |
| Pipeline Minutes | ~15 min/day × 30 = 450 min | Free (2000 min included) |
| App Service | P0v3 | ~$62 |
| **Total** | | **~$63-64/month** |

## Bezpečnost

### Doporučení

1. **Connection Strings**: Vždy v Variable Groups jako Secret
2. **RBAC**: Omezit přístup k pipeline na dev team
3. **Blob SAS**: Použít SAS tokens místo connection strings (optional)
4. **Git Permissions**: DevOps Git read-only pro pipeline

### Příklad SAS Token

```bash
# Generate SAS token with read/write/delete permissions
az storage container generate-sas \
  --account-name <account> \
  --name xpp-metadata \
  --permissions rwdl \
  --expiry 2026-12-31 \
  --https-only
```

## Migrace ze Současného Setup

### Krok 1: První Upload Standard Metadat

```bash
# Extrahovat všechny modely poprvé
EXTRACT_MODE=all npm run extract-metadata

# Upload standard models
npm run blob-manager upload-standard

# Upload custom models
npm run blob-manager upload-custom

# Upload database
npm run build-database
npm run blob-manager upload-database ./data/xpp-metadata.db
```

### Krok 2: Nastavit Azure Pipeline

1. V Azure DevOps vytvořit novou pipeline
2. Použít `azure-pipelines-quick.yml`
3. Konfigurovat Variable Group
4. Test run (manuálně)

### Krok 3: Ověření

```bash
# Download and verify
npm run blob-manager download-all
npm run build-database

# Test MCP server locally
npm run dev
```

### Krok 4: Produkční Nasazení

1. Nastavit scheduler (denně 2:00 UTC)
2. Monitor první 2-3 runs
3. Optimalizovat podle potřeby

## Support

Pro otázky a problémy:
- GitHub Issues: [dynamics365ninja/d365fo-mcp-server](https://github.com/dynamics365ninja/d365fo-mcp-server/issues)
- Documentation: [docs/](../docs/)

## Related Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture
- [AZURE_BLOB_SETUP.md](AZURE_BLOB_SETUP.md) - Azure Blob Storage setup
- [AZURE_TROUBLESHOOTING.md](AZURE_TROUBLESHOOTING.md) - Troubleshooting guide
- [DEVELOPMENT_SETUP.md](DEVELOPMENT_SETUP.md) - Development environment
