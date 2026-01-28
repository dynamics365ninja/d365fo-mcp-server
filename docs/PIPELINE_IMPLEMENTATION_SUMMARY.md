# Přehled Implementace - Azure Pipeline Automatizace

## Implementované Změny

### 1. Nové Soubory

#### `scripts/azure-blob-manager.ts`
Komplexní TypeScript skript pro správu metadat v Azure Blob Storage.

**Funkce:**
- Upload/download standard a custom metadat
- Smazání custom metadat (blob i lokálně)
- Upload/download zkompilované databáze
- Automatická detekce custom vs. standard modelů
- Hierarchická struktura v blob storage

**Klíčové metody:**
- `uploadMetadata(type, models?)` - Upload metadat
- `downloadMetadata(type, models?)` - Download metadat
- `deleteCustomMetadata(models?)` - Smazání custom metadat
- `uploadDatabase()` / `downloadDatabase()` - Správa databáze

#### `azure-pipelines.yml`
Kompletní Azure DevOps pipeline s 5 stages:
1. **Prepare** - Stažení standard metadat
2. **ExtractCustom** - Extrakce custom modelů z Git
3. **BuildDatabase** - Sestavení SQLite databáze
4. **UploadToBlob** - Upload do Azure Blob
5. **Deploy** - Deploy na Azure App Service

#### `azure-pipelines-quick.yml`
Optimalizovaná pipeline pro denní aktualizace:
- **QuickUpdate** - Rychlá aktualizace custom modelů (~5-15 min)
- **FullRebuild** - Kompletní rebuild při potřebě
- Scheduler: Denně v 2:00 UTC
- Parametrizované spouštění

#### `scripts/test-pipeline.ps1`
PowerShell test script pro lokální testování workflow:
- Interaktivní menu s 8 operacemi
- Simulace pipeline kroků
- Validace konfigurace

#### `docs/AZURE_PIPELINE_AUTOMATION.md`
Kompletní dokumentace v češtině:
- Popis problému a řešení
- Architektura systému
- Workflow scénáře
- Konfigurace a setup
- Monitoring a troubleshooting
- Optimalizace a náklady

### 2. Upravené Soubory

#### `package.json`
Přidán nový script:
```json
"blob-manager": "tsx scripts/azure-blob-manager.ts"
```

#### `README.md`
- Přidán odkaz na novou dokumentaci
- Aktualizován seznam related documentation

### 3. Struktura Azure Blob Storage

```
xpp-metadata/
├── metadata/
│   ├── standard/           # Standard D365 modely
│   │   ├── ApplicationFoundation/
│   │   ├── ApplicationPlatform/
│   │   └── ... (500+ modelů)
│   └── custom/             # Custom/ISV modely
│       ├── ISV_Module1/
│       ├── ISV_Module2/
│       └── ...
└── databases/
    └── xpp-metadata-latest.db
```

## Workflow

### Denní Automatizace (Custom Modely)

```
1. Azure Pipeline Trigger (2:00 UTC denně)
   ↓
2. Download Standard Metadata z Blobu (cached, rychlé)
   ↓
3. Delete Old Custom Metadata (blob + local)
   ↓
4. Extract Custom Modely z DevOps Git
   ↓
5. Build Database (standard + new custom)
   ↓
6. Upload Custom Metadata + Database do Blobu
   ↓
7. Restart App Service
```

**Čas:** 5-15 minut (místo 2-3 hodin)
**Úspora:** ~95%

### Periodická Aktualizace (Standard Modely)

```
1. Manuální Trigger (párkrát ročně)
   ↓
2. Clean All Metadata
   ↓
3. Extract ALL Models (standard + custom)
   ↓
4. Build Database
   ↓
5. Upload ALL to Blob
```

**Čas:** 1-3 hodiny
**Frekvence:** Párkrát ročně (D365 upgrade, hotfix)

## Použití

### Lokální Testování

```powershell
# Interaktivní menu
.\scripts\test-pipeline.ps1

# Nebo přímo
npm run blob-manager download-standard
npm run blob-manager upload-custom
npm run blob-manager delete-custom Model1,Model2
```

### Azure Pipeline

```bash
# Denní custom update (automatický)
# Běží podle scheduleru v 2:00 UTC

# Manuální spuštění custom update
az pipelines run --name "Quick Custom Update"

# Manuální full rebuild
az pipelines run --name "Full Metadata Rebuild" --parameters extractionMode=all

# Specifické modely
az pipelines run --name "Quick Custom Update" --parameters customModels=ISV_Module1,ISV_Module2
```

### Konfigurace

#### .env / Azure DevOps Variables

```env
# Azure Blob Storage
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;...
BLOB_CONTAINER_NAME=xpp-metadata

# Custom Models
CUSTOM_MODELS=ISV_Module1,ISV_Module2
EXTENSION_PREFIX=ISV_
EXTRACT_MODE=custom

# Paths
METADATA_PATH=./extracted-metadata
DB_PATH=./data/xpp-metadata.db
PACKAGES_PATH=C:\AOSService\PackagesLocalDirectory  # nebo DevOps Git path
```

#### Azure DevOps Variable Group

Vytvořit `xpp-mcp-server-config`:
- AZURE_STORAGE_CONNECTION_STRING (secret)
- BLOB_CONTAINER_NAME
- CUSTOM_MODELS
- EXTENSION_PREFIX
- AZURE_SUBSCRIPTION
- AZURE_APP_SERVICE_NAME

## Přínosy Řešení

### Výkon
- ✅ **95% úspora času** pro denní aktualizace
- ✅ **5-15 minut** místo 2-3 hodin
- ✅ **Caching** standard metadat

### Náklady
- ✅ **Minimální** - Blob Storage ~$1-2/měsíc
- ✅ **Zdarma Pipeline** - 2000 minut/měsíc included
- ✅ **Efektivní** využití výpočetního času

### Flexibilita
- ✅ **Oddělená** správa standard vs. custom
- ✅ **Inkrementální** updates
- ✅ **Parametrizované** spouštění
- ✅ **Lokální testování**

### Automatizace
- ✅ **Denní scheduler** pro custom modely
- ✅ **Git integration** - automatická extrakce z DevOps
- ✅ **Auto-restart** App Service po update
- ✅ **Monitoring** přes Azure Pipeline logy

## Migrace

### První Setup

1. **Extrakce všech modelů poprvé:**
```bash
EXTRACT_MODE=all npm run extract-metadata
npm run blob-manager upload-all
npm run build-database
npm run blob-manager upload-database
```

2. **Nastavení Azure Pipeline:**
- Vytvořit Variable Group v Azure DevOps
- Importovat `azure-pipelines-quick.yml`
- Konfigurovat scheduler
- Test run

3. **Ověření:**
```bash
npm run blob-manager download-all
npm run build-database
npm run dev  # Test MCP server
```

### Denní Provoz

- Pipeline běží automaticky každý den v 2:00 UTC
- Zpracovává pouze custom modely
- Automatický restart App Service
- Monitoring přes Azure DevOps

## Dokumentace

- **Hlavní README**: [README.md](../README.md)
- **Použití MCP**: [USAGE_EXAMPLES.md](USAGE_EXAMPLES.md)
- **Pipeline Automatizace**: [AZURE_PIPELINE_AUTOMATION.md](AZURE_PIPELINE_AUTOMATION.md)
- **Architektura**: [ARCHITECTURE.md](ARCHITECTURE.md)
- **Custom Extensions**: [CUSTOM_EXTENSIONS.md](CUSTOM_EXTENSIONS.md)

## Support

Pro dotazy:
- GitHub Issues: [dynamics365ninja/d365fo-mcp-server](https://github.com/dynamics365ninja/d365fo-mcp-server/issues)
- Dokumentace: [docs/](../docs/)

## Status

✅ **Implementováno a připraveno k nasazení**

- ✅ Azure Blob Manager
- ✅ Azure Pipeline YAML
- ✅ Test skripty
- ✅ Dokumentace
- ✅ Integration do package.json
- ✅ README aktualizováno
