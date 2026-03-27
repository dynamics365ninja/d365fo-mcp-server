using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml.Linq;
using Microsoft.Dynamics.AX.Metadata.MetaModel;
using Microsoft.Dynamics.AX.Metadata.Providers;
using Microsoft.Dynamics.AX.Metadata.Storage;

namespace D365MetadataBridge.Services
{
    /// <summary>
    /// Creates and modifies D365FO metadata objects using the official IMetadataProvider API.
    /// Uses interface casts (IMetaClassProvider, IMetaTableProvider, etc.) because DiskProvider
    /// implements Create/Update as explicit interface members (dynamic dispatch fails).
    /// </summary>
    public class MetadataWriteService
    {
        private IMetadataProvider _provider;
        private readonly string _packagesPath;

        // Cache resolved ModelSaveInfo per model name
        private readonly Dictionary<string, ModelSaveInfo> _modelCache = new Dictionary<string, ModelSaveInfo>(StringComparer.OrdinalIgnoreCase);

        public MetadataWriteService(IMetadataProvider provider, string packagesPath)
        {
            _provider = provider;
            _packagesPath = packagesPath;
        }

        /// <summary>
        /// Called by MetadataReadService.RefreshProvider() to keep the write service in sync.
        /// </summary>
        public void UpdateProvider(IMetadataProvider newProvider)
        {
            _provider = newProvider;
        }

        // ========================
        // MODEL RESOLUTION
        // ========================

        /// <summary>
        /// Resolves a model name to ModelSaveInfo by reading model descriptor XML files.
        /// Caches results for repeated calls.
        /// </summary>
        public ModelSaveInfo? ResolveModelSaveInfo(string modelName)
        {
            if (_modelCache.TryGetValue(modelName, out var cached))
                return cached;

            // Scan {packagesPath}/{*}/Descriptor/{modelName}.xml
            // First try the direct path (most models: package name = model name)
            var directPath = Path.Combine(_packagesPath, modelName, "Descriptor", modelName + ".xml");
            if (File.Exists(directPath))
            {
                var msi = ParseModelDescriptor(directPath, modelName);
                if (msi != null) { _modelCache[modelName] = msi; return msi; }
            }

            // Fallback: scan all Descriptor folders
            try
            {
                foreach (var packageDir in Directory.GetDirectories(_packagesPath))
                {
                    var descDir = Path.Combine(packageDir, "Descriptor");
                    if (!Directory.Exists(descDir)) continue;

                    foreach (var xmlFile in Directory.GetFiles(descDir, "*.xml"))
                    {
                        var msi = ParseModelDescriptor(xmlFile, modelName);
                        if (msi != null) { _modelCache[modelName] = msi; return msi; }
                    }
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WriteService] Error scanning model descriptors: {ex.Message}");
            }

            return null;
        }

        private ModelSaveInfo? ParseModelDescriptor(string xmlPath, string targetModelName)
        {
            try
            {
                var doc = XDocument.Load(xmlPath);
                var root = doc.Root;
                if (root == null) return null;

                // Handle namespace — descriptor files use xmlns
                var ns = root.GetDefaultNamespace();
                var nameEl = root.Element(ns + "Name") ?? root.Element("Name");
                if (nameEl == null || !string.Equals(nameEl.Value, targetModelName, StringComparison.OrdinalIgnoreCase))
                    return null;

                var idEl = root.Element(ns + "Id") ?? root.Element("Id");
                var layerEl = root.Element(ns + "Layer") ?? root.Element("Layer");

                if (idEl == null || layerEl == null) return null;

                return new ModelSaveInfo
                {
                    Id = int.Parse(idEl.Value),
                    Layer = int.Parse(layerEl.Value)
                };
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WriteService] Error parsing descriptor {xmlPath}: {ex.Message}");
                return null;
            }
        }

        // ========================
        // CREATE OPERATIONS
        // ========================

        /// <summary>
        /// Creates a new AxClass via IMetaClassProvider.Create().
        /// </summary>
        public object CreateClass(string name, string modelName, string? declaration,
            List<WriteMethodParam>? methods, Dictionary<string, string>? properties)
        {
            var msi = ResolveModelSaveInfo(modelName)
                ?? throw new ArgumentException($"Model '{modelName}' not found in {_packagesPath}");

            var axClass = new AxClass { Name = name };

            // Set declaration (class header + member variables)
            if (!string.IsNullOrEmpty(declaration))
                axClass.Declaration = declaration;
            else
                axClass.Declaration = $"public class {name}\n{{\n}}";

            // Apply properties
            if (properties != null)
            {
                foreach (var kv in properties)
                    SetAxClassProperty(axClass, kv.Key, kv.Value);
            }

            // Add methods
            if (methods != null)
            {
                foreach (var m in methods)
                {
                    var axMethod = new AxMethod { Name = m.Name, Source = m.Source ?? "" };
                    axClass.AddMethod(axMethod);
                }
            }

            // Write to disk via provider API
            var classProvider = _provider.Classes as IMetaClassProvider
                ?? throw new InvalidOperationException("DiskProvider.Classes does not implement IMetaClassProvider");
            classProvider.Create(axClass, msi);

            var filePath = GetExpectedPath("AxClass", name, modelName);
            return new { success = true, objectType = "class", objectName = name, modelName, filePath, api = "IMetaClassProvider.Create" };
        }

        /// <summary>
        /// Creates a new AxTable via IMetaTableProvider.Create().
        /// </summary>
        public object CreateTable(string name, string modelName,
            List<WriteFieldParam>? fields, List<WriteFieldGroupParam>? fieldGroups,
            List<WriteIndexParam>? indexes, List<WriteRelationParam>? relations,
            List<WriteMethodParam>? methods, Dictionary<string, string>? properties)
        {
            var msi = ResolveModelSaveInfo(modelName)
                ?? throw new ArgumentException($"Model '{modelName}' not found in {_packagesPath}");

            var axTable = new AxTable { Name = name };

            // Apply table-level properties (Label, TableGroup, CacheLookup, etc.)
            if (properties != null)
            {
                foreach (var kv in properties)
                    SetAxTableProperty(axTable, kv.Key, kv.Value);
            }

            // Add fields
            if (fields != null)
            {
                foreach (var f in fields)
                {
                    var axField = CreateTableField(f);
                    axTable.AddField(axField);
                }
            }

            // Add field groups
            if (fieldGroups != null)
            {
                foreach (var fg in fieldGroups)
                {
                    var axFg = new AxTableFieldGroup { Name = fg.Name, Label = fg.Label };
                    if (fg.Fields != null)
                    {
                        foreach (var fieldRef in fg.Fields)
                        {
                            var fgField = new AxTableFieldGroupField { DataField = fieldRef };
                            axFg.AddField(fgField);
                        }
                    }
                    axTable.AddFieldGroup(axFg);
                }
            }

            // Add indexes
            if (indexes != null)
            {
                foreach (var ix in indexes)
                {
                    var axIdx = new AxTableIndex { Name = ix.Name };
                    axIdx.AllowDuplicates = ix.AllowDuplicates ? Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.Yes : Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.No;
                    if (ix.AlternateKey)
                        axIdx.AlternateKey = Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.Yes;
                    if (ix.Fields != null)
                    {
                        foreach (var ixf in ix.Fields)
                        {
                            var axIxField = new AxTableIndexField { DataField = ixf };
                            axIdx.AddField(axIxField);
                        }
                    }
                    axTable.AddIndex(axIdx);
                }
            }

            // Add relations
            if (relations != null)
            {
                foreach (var rel in relations)
                {
                    var axRel = new AxTableRelation { Name = rel.Name, RelatedTable = rel.RelatedTable ?? "" };
                    if (rel.Constraints != null)
                    {
                        foreach (var c in rel.Constraints)
                        {
                            var constraint = new AxTableRelationConstraintField
                            {
                                Name = c.Field ?? "",
                                Field = c.Field ?? "",
                                RelatedField = c.RelatedField ?? ""
                            };
                            axRel.AddConstraint(constraint);
                        }
                    }
                    axTable.AddRelation(axRel);
                }
            }

            // Add methods
            if (methods != null)
            {
                foreach (var m in methods)
                {
                    var axMethod = new AxMethod { Name = m.Name, Source = m.Source ?? "" };
                    axTable.AddMethod(axMethod);
                }
            }

            var tableProvider = _provider.Tables as IMetaTableProvider
                ?? throw new InvalidOperationException("DiskProvider.Tables does not implement IMetaTableProvider");
            tableProvider.Create(axTable, msi);

            var filePath = GetExpectedPath("AxTable", name, modelName);
            return new { success = true, objectType = "table", objectName = name, modelName, filePath, api = "IMetaTableProvider.Create" };
        }

        /// <summary>
        /// Creates a new AxTable with BP-smart defaults auto-derived from table group and type.
        /// Auto-generates: CacheLookup, SaveDataPerCompany, TitleField1/2, PrimaryIndex,
        /// ClusteredIndex, ReplacementKey, 5 standard FieldGroups (AutoReport, AutoLookup,
        /// AutoIdentification, AutoSummary, AutoBrowse), and DeleteActions (Restricted).
        /// This is the primary creation path for generate_smart_table — all BP logic lives here.
        /// </summary>
        public object CreateSmartTable(string name, string modelName,
            string? tableGroup, string? tableType, string? label,
            List<WriteFieldParam>? fields, List<WriteFieldGroupParam>? extraFieldGroups,
            List<WriteIndexParam>? indexes, List<WriteRelationParam>? relations,
            List<WriteMethodParam>? methods, Dictionary<string, string>? extraProperties)
        {
            var msi = ResolveModelSaveInfo(modelName)
                ?? throw new ArgumentException($"Model '{modelName}' not found in {_packagesPath}");

            var axTable = new AxTable { Name = name };

            // ── Validate TableGroup (TempDB/InMemory are TableType, NOT TableGroup) ──
            if (tableGroup == "TempDB" || tableGroup == "InMemory")
                throw new ArgumentException(
                    $"Invalid TableGroup '{tableGroup}'. 'TempDB' and 'InMemory' are TableType values, " +
                    "not TableGroup values. Pass them via the tableType parameter instead.");

            var normalizedTableType = string.IsNullOrEmpty(tableType)
                || tableType!.Equals("RegularTable", StringComparison.OrdinalIgnoreCase)
                ? "" : tableType;
            var isTempTable = normalizedTableType == "TempDB" || normalizedTableType == "InMemory";
            var effectiveTableGroup = string.IsNullOrEmpty(tableGroup) ? "Main" : tableGroup;

            // ── Declaration with doc comment ──
            axTable.Declaration = $"/// <summary>\n/// The <c>{name}</c> table.\n/// </summary>\npublic class {name} extends common\n{{\n}}";

            // ── Label ──
            if (!string.IsNullOrEmpty(label))
                axTable.Label = label;

            // ── TableGroup ──
            if (Enum.TryParse<Microsoft.Dynamics.AX.Metadata.Core.MetaModel.TableGroup>(effectiveTableGroup, true, out var tg))
                axTable.TableGroup = tg;

            // ── TableType (only for TempDB / InMemory — RegularTable is the default, omitted) ──
            if (!string.IsNullOrEmpty(normalizedTableType))
            {
                if (Enum.TryParse<Microsoft.Dynamics.AX.Metadata.Core.MetaModel.TableType>(normalizedTableType, true, out var tt))
                    axTable.TableType = tt;
            }

            // ── BP: CacheLookup — set based on TableGroup to avoid BP warning ──
            if (isTempTable)
            {
                axTable.CacheLookup = Microsoft.Dynamics.AX.Metadata.Core.MetaModel.RecordCacheLevel.None;
            }
            else
            {
                var cacheLookupMap = new Dictionary<string, Microsoft.Dynamics.AX.Metadata.Core.MetaModel.RecordCacheLevel>(StringComparer.OrdinalIgnoreCase)
                {
                    ["Parameter"]       = Microsoft.Dynamics.AX.Metadata.Core.MetaModel.RecordCacheLevel.Found,
                    ["Group"]           = Microsoft.Dynamics.AX.Metadata.Core.MetaModel.RecordCacheLevel.Found,
                    ["Main"]            = Microsoft.Dynamics.AX.Metadata.Core.MetaModel.RecordCacheLevel.Found,
                    ["Transaction"]     = Microsoft.Dynamics.AX.Metadata.Core.MetaModel.RecordCacheLevel.None,
                    ["WorksheetHeader"] = Microsoft.Dynamics.AX.Metadata.Core.MetaModel.RecordCacheLevel.None,
                    ["WorksheetLine"]   = Microsoft.Dynamics.AX.Metadata.Core.MetaModel.RecordCacheLevel.None,
                    ["Miscellaneous"]   = Microsoft.Dynamics.AX.Metadata.Core.MetaModel.RecordCacheLevel.NotInTTS,
                    ["Framework"]       = Microsoft.Dynamics.AX.Metadata.Core.MetaModel.RecordCacheLevel.Found,
                    ["Reference"]       = Microsoft.Dynamics.AX.Metadata.Core.MetaModel.RecordCacheLevel.Found,
                };
                axTable.CacheLookup = cacheLookupMap.TryGetValue(effectiveTableGroup!, out var cl)
                    ? cl
                    : Microsoft.Dynamics.AX.Metadata.Core.MetaModel.RecordCacheLevel.Found;
            }

            // ── BP: SaveDataPerCompany — TempDB/InMemory are session-scoped, not company-scoped ──
            axTable.SaveDataPerCompany = isTempTable
                ? Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.No
                : Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.Yes;

            // ── Add fields ──
            var fieldNames = new List<string>();
            if (fields != null)
            {
                foreach (var f in fields)
                {
                    var axField = CreateTableField(f);
                    axTable.AddField(axField);
                    fieldNames.Add(f.Name);
                }
            }

            // ── BP: TitleField1/TitleField2 — first two non-RecId fields ──
            var titleCandidates = fieldNames
                .Where(n => !n.Equals("RecId", StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (titleCandidates.Count > 0) axTable.TitleField1 = titleCandidates[0];
            if (titleCandidates.Count > 1) axTable.TitleField2 = titleCandidates[1];

            // ── Add indexes + track unique/clustered for PrimaryIndex/ClusteredIndex ──
            string? uniqueIndexName = null;
            string? clusteredIndexName = null;
            if (indexes != null)
            {
                foreach (var ix in indexes)
                {
                    var axIdx = new AxTableIndex { Name = ix.Name };
                    axIdx.AllowDuplicates = ix.AllowDuplicates
                        ? Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.Yes
                        : Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.No;
                    if (ix.AlternateKey || !ix.AllowDuplicates)
                    {
                        axIdx.AlternateKey = Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.Yes;
                        axIdx.AllowDuplicates = Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.No;
                        if (uniqueIndexName == null) uniqueIndexName = ix.Name;
                    }
                    if (ix.Fields != null)
                    {
                        foreach (var ixf in ix.Fields)
                            axIdx.AddField(new AxTableIndexField { DataField = ixf });
                    }
                    axTable.AddIndex(axIdx);
                }
            }

            // ── BP: PrimaryIndex / ReplacementKey / ClusteredIndex ──
            if (uniqueIndexName != null)
            {
                axTable.PrimaryIndex = uniqueIndexName;
                axTable.ReplacementKey = uniqueIndexName;
                axTable.ClusteredIndex = clusteredIndexName ?? uniqueIndexName;
            }

            // ── BP: DeleteActions — Restricted for each relation target table ──
            if (relations != null)
            {
                foreach (var rel in relations)
                {
                    var relTable = rel.RelatedTable ?? "";
                    if (!string.IsNullOrEmpty(relTable))
                    {
                        try
                        {
                            axTable.DeleteActions.Add(new AxTableDeleteAction
                            {
                                Name = relTable,
                                Table = relTable,
                                DeleteAction = Microsoft.Dynamics.AX.Metadata.Core.MetaModel.DeleteAction.Restricted,
                            });
                        }
                        catch (Exception ex)
                        {
                            Console.Error.WriteLine($"[WriteService] DeleteAction for '{relTable}' skipped: {ex.Message}");
                        }
                    }
                }
            }

            // ── BP: 5 standard FieldGroups ──
            var nonRecIdFields = fieldNames
                .Where(n => !n.Equals("RecId", StringComparison.OrdinalIgnoreCase))
                .ToList();

            // AutoReport — first 5 fields (BP requires at least one field)
            var autoReport = new AxTableFieldGroup { Name = "AutoReport" };
            foreach (var f in nonRecIdFields.Take(5))
                autoReport.AddField(new AxTableFieldGroupField { DataField = f });
            axTable.AddFieldGroup(autoReport);

            // AutoLookup — first 3 fields
            var autoLookup = new AxTableFieldGroup { Name = "AutoLookup" };
            foreach (var f in nonRecIdFields.Take(3))
                autoLookup.AddField(new AxTableFieldGroupField { DataField = f });
            axTable.AddFieldGroup(autoLookup);

            // AutoIdentification — empty with AutoPopulate=Yes
            var autoIdent = new AxTableFieldGroup { Name = "AutoIdentification" };
            autoIdent.AutoPopulate = Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.Yes;
            axTable.AddFieldGroup(autoIdent);

            // AutoSummary
            axTable.AddFieldGroup(new AxTableFieldGroup { Name = "AutoSummary" });

            // AutoBrowse
            axTable.AddFieldGroup(new AxTableFieldGroup { Name = "AutoBrowse" });

            // Extra field groups from caller (beyond the standard 5)
            if (extraFieldGroups != null)
            {
                foreach (var fg in extraFieldGroups)
                {
                    var axFg = new AxTableFieldGroup { Name = fg.Name, Label = fg.Label };
                    if (fg.Fields != null)
                    {
                        foreach (var fieldRef in fg.Fields)
                            axFg.AddField(new AxTableFieldGroupField { DataField = fieldRef });
                    }
                    axTable.AddFieldGroup(axFg);
                }
            }

            // ── Add relations ──
            if (relations != null)
            {
                foreach (var rel in relations)
                {
                    var axRel = new AxTableRelation { Name = rel.Name, RelatedTable = rel.RelatedTable ?? "" };
                    if (rel.Constraints != null)
                    {
                        foreach (var c in rel.Constraints)
                        {
                            axRel.AddConstraint(new AxTableRelationConstraintField
                            {
                                Name = c.Field ?? "",
                                Field = c.Field ?? "",
                                RelatedField = c.RelatedField ?? "",
                            });
                        }
                    }
                    axTable.AddRelation(axRel);
                }
            }

            // ── Add methods ──
            if (methods != null)
            {
                foreach (var m in methods)
                    axTable.AddMethod(new AxMethod { Name = m.Name, Source = m.Source ?? "" });
            }

            // ── Apply any extra properties (overrides auto-set values if needed) ──
            if (extraProperties != null)
            {
                foreach (var kv in extraProperties)
                    SetAxTableProperty(axTable, kv.Key, kv.Value);
            }

            // ── Write to disk via IMetadataProvider ──
            var tableProvider = _provider.Tables as IMetaTableProvider
                ?? throw new InvalidOperationException("DiskProvider.Tables does not implement IMetaTableProvider");
            tableProvider.Create(axTable, msi);

            var filePath = GetExpectedPath("AxTable", name, modelName);
            return new
            {
                success = true,
                objectType = "table",
                objectName = name,
                modelName,
                filePath,
                api = "IMetaTableProvider.Create (Smart)",
                bpDefaults = new
                {
                    cacheLookup = axTable.CacheLookup.ToString(),
                    saveDataPerCompany = axTable.SaveDataPerCompany.ToString(),
                    titleField1 = axTable.TitleField1,
                    titleField2 = axTable.TitleField2,
                    primaryIndex = axTable.PrimaryIndex,
                    clusteredIndex = axTable.ClusteredIndex,
                    fieldGroupCount = 5 + (extraFieldGroups?.Count ?? 0),
                    deleteActionCount = relations?.Count ?? 0,
                },
            };
        }

        /// <summary>
        /// Creates a new AxEnum via IMetaEnumProvider.Create().
        /// </summary>
        public object CreateEnum(string name, string modelName,
            List<WriteEnumValueParam>? values, Dictionary<string, string>? properties)
        {
            var msi = ResolveModelSaveInfo(modelName)
                ?? throw new ArgumentException($"Model '{modelName}' not found in {_packagesPath}");

            var axEnum = new AxEnum { Name = name };

            // Properties
            if (properties != null)
            {
                foreach (var kv in properties)
                    SetAxEnumProperty(axEnum, kv.Key, kv.Value);
            }

            // Values
            if (values != null)
            {
                foreach (var v in values)
                {
                    var axVal = new AxEnumValue { Name = v.Name, Value = v.Value };
                    if (!string.IsNullOrEmpty(v.Label)) axVal.Label = v.Label;
                    axEnum.AddEnumValue(axVal);
                }
            }

            var enumProvider = _provider.Enums as IMetaEnumProvider
                ?? throw new InvalidOperationException("DiskProvider.Enums does not implement IMetaEnumProvider");
            enumProvider.Create(axEnum, msi);

            var filePath = GetExpectedPath("AxEnum", name, modelName);
            return new { success = true, objectType = "enum", objectName = name, modelName, filePath, api = "IMetaEnumProvider.Create" };
        }

        /// <summary>
        /// Creates a new AxEdt via IMetaEdtProvider.Create().
        /// </summary>
        public object CreateEdt(string name, string modelName, Dictionary<string, string>? properties)
        {
            var msi = ResolveModelSaveInfo(modelName)
                ?? throw new ArgumentException($"Model '{modelName}' not found in {_packagesPath}");

            // AxEdt is abstract — determine the concrete subtype from properties
            var baseType = properties != null && properties.TryGetValue("BaseType", out var bt) ? bt : null;
            var extends_ = properties != null && properties.TryGetValue("Extends", out var ext) ? ext : null;

            AxEdt axEdt;
            switch ((baseType ?? "string").ToLowerInvariant())
            {
                case "int": case "integer": axEdt = new AxEdtInt { Name = name }; break;
                case "real": axEdt = new AxEdtReal { Name = name }; break;
                case "date": axEdt = new AxEdtDate { Name = name }; break;
                case "utcdatetime": case "datetime": axEdt = new AxEdtUtcDateTime { Name = name }; break;
                case "int64": axEdt = new AxEdtInt64 { Name = name }; break;
                case "enum": axEdt = new AxEdtEnum { Name = name }; break;
                case "guid": axEdt = new AxEdtGuid { Name = name }; break;
                case "container": axEdt = new AxEdtContainer { Name = name }; break;
                default: axEdt = new AxEdtString { Name = name }; break;
            }

            if (properties != null)
            {
                foreach (var kv in properties)
                    SetAxEdtProperty(axEdt, kv.Key, kv.Value);
            }

            var edtProvider = _provider.Edts as IMetaEdtProvider
                ?? throw new InvalidOperationException("DiskProvider.Edts does not implement IMetaEdtProvider");
            edtProvider.Create(axEdt, msi);

            var filePath = GetExpectedPath("AxEdt", name, modelName);
            return new { success = true, objectType = "edt", objectName = name, modelName, filePath, api = "IMetaEdtProvider.Create" };
        }

        /// <summary>
        /// Creates a new Query object via IMetaQueryProvider.
        /// AxQuery is abstract — use AxQuerySimple (concrete subclass) for creation.
        /// </summary>
        public object CreateQuery(string name, string modelName, Dictionary<string, string>? properties)
        {
            var msi = ResolveModelSaveInfo(modelName);

            // AxQuery is abstract. Use reflection to try AxQuerySimple first.
            // If that fails, fall back by creating a dynamic instance.
            AxQuery axQuery;
            try
            {
                var queryType = typeof(AxQuery).Assembly.GetType("Microsoft.Dynamics.AX.Metadata.MetaModel.AxQuerySimple");
                if (queryType != null)
                {
                    axQuery = (AxQuery)Activator.CreateInstance(queryType)!;
                }
                else
                {
                    throw new InvalidOperationException("AxQuerySimple type not found in metadata assembly");
                }
            }
            catch
            {
                throw new InvalidOperationException("Cannot create AxQuery instance — AxQuery is abstract and AxQuerySimple was not found. Use XML fallback.");
            }
            axQuery.Name = name;

            if (properties != null)
            {
                foreach (var kv in properties)
                    SetAxQueryProperty(axQuery, kv.Key, kv.Value);
            }

            var queryProvider = _provider.Queries as IMetaQueryProvider
                ?? throw new InvalidOperationException("DiskProvider.Queries does not implement IMetaQueryProvider");
            queryProvider.Create(axQuery, msi);

            var filePath = GetExpectedPath("AxQuery", name, modelName);
            return new { success = true, objectType = "query", objectName = name, modelName, filePath, api = "IMetaQueryProvider.Create" };
        }

        /// <summary>
        /// Creates a new View object via IMetaViewProvider.
        /// Note: View fields are NOT added during creation because AxViewField is abstract.
        /// Use modify_d365fo_file to add fields after creation, or pass xmlContent for full XML.
        /// </summary>
        public object CreateView(string name, string modelName,
            List<WriteFieldParam>? fields,
            Dictionary<string, string>? properties)
        {
            var msi = ResolveModelSaveInfo(modelName);
            var axView = new AxView { Name = name };

            if (properties != null)
            {
                foreach (var kv in properties)
                    SetAxViewProperty(axView, kv.Key, kv.Value);
            }

            // Note: AxViewField is abstract — field creation is skipped during initial Create.
            // Fields should be added via modify_d365fo_file or by passing full xmlContent.
            if (fields != null && fields.Count > 0)
            {
                Console.Error.WriteLine($"[WriteService] CreateView: {fields.Count} fields requested but AxViewField is abstract — fields skipped. Use XML fallback for views with fields.");
            }

            var viewProvider = _provider.Views as IMetaViewProvider
                ?? throw new InvalidOperationException("DiskProvider.Views does not implement IMetaViewProvider");
            viewProvider.Create(axView, msi);

            var filePath = GetExpectedPath("AxView", name, modelName);
            return new { success = true, objectType = "view", objectName = name, modelName, filePath, api = "IMetaViewProvider.Create" };
        }

        /// <summary>
        /// Creates a new MenuItemAction object via IMetaMenuItemActionProvider.
        /// </summary>
        public object CreateMenuItemAction(string name, string modelName, Dictionary<string, string>? properties)
        {
            var msi = ResolveModelSaveInfo(modelName);
            var axMI = new AxMenuItemAction { Name = name };

            if (properties != null)
            {
                foreach (var kv in properties)
                    SetAxMenuItemProperty(axMI, kv.Key, kv.Value);
            }

            var provider = _provider.MenuItemActions as IMetaMenuItemActionProvider
                ?? throw new InvalidOperationException("DiskProvider.MenuItemActions does not implement IMetaMenuItemActionProvider");
            provider.Create(axMI, msi);

            var filePath = GetExpectedPath("AxMenuItemAction", name, modelName);
            return new { success = true, objectType = "menu-item-action", objectName = name, modelName, filePath, api = "IMetaMenuItemActionProvider.Create" };
        }

        /// <summary>
        /// Creates a new MenuItemDisplay object via IMetaMenuItemDisplayProvider.
        /// </summary>
        public object CreateMenuItemDisplay(string name, string modelName, Dictionary<string, string>? properties)
        {
            var msi = ResolveModelSaveInfo(modelName);
            var axMI = new AxMenuItemDisplay { Name = name };

            if (properties != null)
            {
                foreach (var kv in properties)
                    SetAxMenuItemProperty(axMI, kv.Key, kv.Value);
            }

            var provider = _provider.MenuItemDisplays as IMetaMenuItemDisplayProvider
                ?? throw new InvalidOperationException("DiskProvider.MenuItemDisplays does not implement IMetaMenuItemDisplayProvider");
            provider.Create(axMI, msi);

            var filePath = GetExpectedPath("AxMenuItemDisplay", name, modelName);
            return new { success = true, objectType = "menu-item-display", objectName = name, modelName, filePath, api = "IMetaMenuItemDisplayProvider.Create" };
        }

        /// <summary>
        /// Creates a new MenuItemOutput object via IMetaMenuItemOutputProvider.
        /// </summary>
        public object CreateMenuItemOutput(string name, string modelName, Dictionary<string, string>? properties)
        {
            var msi = ResolveModelSaveInfo(modelName);
            var axMI = new AxMenuItemOutput { Name = name };

            if (properties != null)
            {
                foreach (var kv in properties)
                    SetAxMenuItemProperty(axMI, kv.Key, kv.Value);
            }

            var provider = _provider.MenuItemOutputs as IMetaMenuItemOutputProvider
                ?? throw new InvalidOperationException("DiskProvider.MenuItemOutputs does not implement IMetaMenuItemOutputProvider");
            provider.Create(axMI, msi);

            var filePath = GetExpectedPath("AxMenuItemOutput", name, modelName);
            return new { success = true, objectType = "menu-item-output", objectName = name, modelName, filePath, api = "IMetaMenuItemOutputProvider.Create" };
        }

        /// <summary>
        /// Creates a new SecurityPrivilege object via IMetaSecurityPrivilegeProvider.
        /// </summary>
        public object CreateSecurityPrivilege(string name, string modelName, Dictionary<string, string>? properties)
        {
            var msi = ResolveModelSaveInfo(modelName);
            var axObj = new AxSecurityPrivilege { Name = name };

            if (properties != null)
            {
                foreach (var kv in properties)
                    SetAxSecurityPrivilegeProperty(axObj, kv.Key, kv.Value);
            }

            var provider = _provider.SecurityPrivileges as IMetaSecurityPrivilegeProvider
                ?? throw new InvalidOperationException("DiskProvider.SecurityPrivileges does not implement IMetaSecurityPrivilegeProvider");
            provider.Create(axObj, msi);

            var filePath = GetExpectedPath("AxSecurityPrivilege", name, modelName);
            return new { success = true, objectType = "security-privilege", objectName = name, modelName, filePath, api = "IMetaSecurityPrivilegeProvider.Create" };
        }

        /// <summary>
        /// Creates a new SecurityDuty object via IMetaSecurityDutyProvider.
        /// </summary>
        public object CreateSecurityDuty(string name, string modelName, Dictionary<string, string>? properties)
        {
            var msi = ResolveModelSaveInfo(modelName);
            var axObj = new AxSecurityDuty { Name = name };

            if (properties != null)
            {
                foreach (var kv in properties)
                    SetAxSecurityDutyProperty(axObj, kv.Key, kv.Value);
            }

            var provider = _provider.SecurityDuties as IMetaSecurityDutyProvider
                ?? throw new InvalidOperationException("DiskProvider.SecurityDuties does not implement IMetaSecurityDutyProvider");
            provider.Create(axObj, msi);

            var filePath = GetExpectedPath("AxSecurityDuty", name, modelName);
            return new { success = true, objectType = "security-duty", objectName = name, modelName, filePath, api = "IMetaSecurityDutyProvider.Create" };
        }

        /// <summary>
        /// Creates a new SecurityRole object via IMetaSecurityRoleProvider.
        /// </summary>
        public object CreateSecurityRole(string name, string modelName, Dictionary<string, string>? properties)
        {
            var msi = ResolveModelSaveInfo(modelName);
            var axObj = new AxSecurityRole { Name = name };

            if (properties != null)
            {
                foreach (var kv in properties)
                    SetAxSecurityRoleProperty(axObj, kv.Key, kv.Value);
            }

            var provider = _provider.SecurityRoles as IMetaSecurityRoleProvider
                ?? throw new InvalidOperationException("DiskProvider.SecurityRoles does not implement IMetaSecurityRoleProvider");
            provider.Create(axObj, msi);

            var filePath = GetExpectedPath("AxSecurityRole", name, modelName);
            return new { success = true, objectType = "security-role", objectName = name, modelName, filePath, api = "IMetaSecurityRoleProvider.Create" };
        }

        // ========================
        // CREATE EXTENSION OBJECTS
        // ========================

        /// <summary>
        /// Creates a new AxTableExtension via DiskProvider.
        /// Extension name format: "BaseTable.ModelExtension"
        /// </summary>
        public object CreateTableExtension(string name, string modelName,
            List<WriteFieldParam>? fields, List<WriteFieldGroupParam>? fieldGroups,
            List<WriteIndexParam>? indexes, List<WriteRelationParam>? relations,
            List<WriteMethodParam>? methods, Dictionary<string, string>? properties)
        {
            var msi = ResolveModelSaveInfo(modelName)
                ?? throw new ArgumentException($"Model '{modelName}' not found in {_packagesPath}");

            var axExt = new AxTableExtension { Name = name };

            // Add fields
            if (fields != null)
            {
                foreach (var f in fields)
                {
                    var axField = CreateTableField(f);
                    axExt.Fields.Add(axField);
                }
            }

            // Add field groups
            if (fieldGroups != null)
            {
                foreach (var fg in fieldGroups)
                {
                    var axFg = new AxTableFieldGroup { Name = fg.Name, Label = fg.Label };
                    if (fg.Fields != null)
                    {
                        foreach (var fieldRef in fg.Fields)
                            axFg.AddField(new AxTableFieldGroupField { DataField = fieldRef });
                    }
                    axExt.FieldGroups.Add(axFg);
                }
            }

            // Add indexes
            if (indexes != null)
            {
                foreach (var ix in indexes)
                {
                    var axIdx = new AxTableIndex { Name = ix.Name };
                    axIdx.AllowDuplicates = ix.AllowDuplicates
                        ? Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.Yes
                        : Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.No;
                    if (ix.AlternateKey)
                        axIdx.AlternateKey = Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.Yes;
                    if (ix.Fields != null)
                    {
                        foreach (var ixf in ix.Fields)
                            axIdx.AddField(new AxTableIndexField { DataField = ixf });
                    }
                    axExt.Indexes.Add(axIdx);
                }
            }

            // Add relations
            if (relations != null)
            {
                foreach (var rel in relations)
                {
                    var axRel = new AxTableRelation { Name = rel.Name, RelatedTable = rel.RelatedTable ?? "" };
                    if (rel.Constraints != null)
                    {
                        foreach (var c in rel.Constraints)
                        {
                            axRel.AddConstraint(new AxTableRelationConstraintField
                            {
                                Name = c.Field ?? "",
                                Field = c.Field ?? "",
                                RelatedField = c.RelatedField ?? ""
                            });
                        }
                    }
                    axExt.Relations.Add(axRel);
                }
            }

            // Add methods (AxTableExtension doesn't expose Methods statically — use dynamic)
            if (methods != null)
            {
                foreach (var m in methods)
                    ((dynamic)axExt).Methods.Add(new AxMethod { Name = m.Name, Source = m.Source ?? "" });
            }

            var provider = _provider.TableExtensions as IMetaTableExtensionProvider
                ?? throw new InvalidOperationException("DiskProvider.TableExtensions does not implement IMetaTableExtensionProvider");
            provider.Create(axExt, msi);

            var filePath = GetExpectedPath("AxTableExtension", name, modelName);
            return new { success = true, objectType = "table-extension", objectName = name, modelName, filePath, api = "IMetaTableExtensionProvider.Create" };
        }

        /// <summary>
        /// Creates a new AxFormExtension via DiskProvider.
        /// Extension name format: "BaseForm.ModelExtension"
        /// </summary>
        public object CreateFormExtension(string name, string modelName,
            List<WriteMethodParam>? methods, Dictionary<string, string>? properties)
        {
            var msi = ResolveModelSaveInfo(modelName)
                ?? throw new ArgumentException($"Model '{modelName}' not found in {_packagesPath}");

            var axExt = new AxFormExtension { Name = name };

            if (methods != null)
            {
                foreach (var m in methods)
                    ((dynamic)axExt).Methods.Add(new AxMethod { Name = m.Name, Source = m.Source ?? "" });
            }

            var provider = _provider.FormExtensions as IMetaFormExtensionProvider
                ?? throw new InvalidOperationException("DiskProvider.FormExtensions does not implement IMetaFormExtensionProvider");
            provider.Create(axExt, msi);

            var filePath = GetExpectedPath("AxFormExtension", name, modelName);
            return new { success = true, objectType = "form-extension", objectName = name, modelName, filePath, api = "IMetaFormExtensionProvider.Create" };
        }

        /// <summary>
        /// Creates a new AxEnumExtension via DiskProvider.
        /// Extension name format: "BaseEnum.ModelExtension"
        /// </summary>
        public object CreateEnumExtension(string name, string modelName,
            List<WriteEnumValueParam>? values, Dictionary<string, string>? properties)
        {
            var msi = ResolveModelSaveInfo(modelName)
                ?? throw new ArgumentException($"Model '{modelName}' not found in {_packagesPath}");

            var axExt = new AxEnumExtension { Name = name };

            if (values != null)
            {
                foreach (var v in values)
                {
                    var axVal = new AxEnumValue { Name = v.Name, Value = v.Value };
                    if (!string.IsNullOrEmpty(v.Label)) axVal.Label = v.Label;
                    axExt.EnumValues.Add(axVal);
                }
            }

            var provider = _provider.EnumExtensions as IMetaEnumExtensionProvider
                ?? throw new InvalidOperationException("DiskProvider.EnumExtensions does not implement IMetaEnumExtensionProvider");
            provider.Create(axExt, msi);

            var filePath = GetExpectedPath("AxEnumExtension", name, modelName);
            return new { success = true, objectType = "enum-extension", objectName = name, modelName, filePath, api = "IMetaEnumExtensionProvider.Create" };
        }

        /// <summary>
        /// Creates a new AxForm via IMetaFormProvider.Create().
        /// Note: Only basic structure (name, data sources, methods). Complex design trees should
        /// use xmlContent fallback. Controls are not added during creation.
        /// </summary>
        public object CreateForm(string name, string modelName,
            List<WriteMethodParam>? methods, Dictionary<string, string>? properties)
        {
            // TODO [Phase 2]: CreateSmartForm — port FormPatternTemplates (SimpleList, DetailsMaster,
            // DetailsTransaction, Workspace, etc.) from TypeScript to C# so that generate_smart_form
            // can use the bridge like generate_smart_table does with CreateSmartTable.
            var msi = ResolveModelSaveInfo(modelName)
                ?? throw new ArgumentException($"Model '{modelName}' not found in {_packagesPath}");

            var axForm = new AxForm { Name = name };

            if (properties != null)
            {
                foreach (var kv in properties)
                {
                    switch (kv.Key.ToLowerInvariant())
                    {
                        case "label": axForm.Design.Caption = kv.Value; break;
                        case "caption": axForm.Design.Caption = kv.Value; break;
                    }
                }
            }

            if (methods != null)
            {
                foreach (var m in methods)
                    axForm.AddMethod(new AxMethod { Name = m.Name, Source = m.Source ?? "" });
            }

            var provider = _provider.Forms as IMetaFormProvider
                ?? throw new InvalidOperationException("DiskProvider.Forms does not implement IMetaFormProvider");
            provider.Create(axForm, msi);

            var filePath = GetExpectedPath("AxForm", name, modelName);
            return new { success = true, objectType = "form", objectName = name, modelName, filePath, api = "IMetaFormProvider.Create" };
        }

        /// <summary>
        /// Creates a new AxMenu via DiskProvider.
        /// </summary>
        public object CreateMenu(string name, string modelName, Dictionary<string, string>? properties)
        {
            var msi = ResolveModelSaveInfo(modelName)
                ?? throw new ArgumentException($"Model '{modelName}' not found in {_packagesPath}");

            var axMenu = new AxMenu { Name = name };

            if (properties != null)
            {
                foreach (var kv in properties)
                {
                    switch (kv.Key.ToLowerInvariant())
                    {
                        case "label": axMenu.Label = kv.Value; break;
                    }
                }
            }

            var provider = _provider.Menus as IMetaMenuProvider
                ?? throw new InvalidOperationException("DiskProvider.Menus does not implement IMetaMenuProvider");
            provider.Create(axMenu, msi);

            var filePath = GetExpectedPath("AxMenu", name, modelName);
            return new { success = true, objectType = "menu", objectName = name, modelName, filePath, api = "IMetaMenuProvider.Create" };
        }

        // ========================
        // MODIFY OPERATIONS
        // ========================

        /// <summary>
        /// Adds or replaces a method on a class or table.
        /// Read → add/replace method → Update.
        /// </summary>
        public object AddMethod(string objectType, string objectName, string methodName, string source)
        {
            switch (objectType.ToLowerInvariant())
            {
                case "class":
                {
                    var axClass = _provider.Classes.Read(objectName)
                        ?? throw new ArgumentException($"Class '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Classes, objectName);

                    // Remove existing method with same name
                    RemoveMethodIfExists(axClass, methodName);

                    var axMethod = new AxMethod { Name = methodName, Source = source };
                    axClass.AddMethod(axMethod);

                    var classProvider = _provider.Classes as IMetaClassProvider
                        ?? throw new InvalidOperationException("IMetaClassProvider not available");
                    classProvider.Update(axClass, msi);

                    return new { success = true, operation = "add-method", objectType, objectName, methodName, api = "IMetaClassProvider.Update" };
                }
                case "table":
                {
                    var axTable = _provider.Tables.Read(objectName)
                        ?? throw new ArgumentException($"Table '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Tables, objectName);

                    RemoveMethodIfExists(axTable, methodName);

                    var axMethod = new AxMethod { Name = methodName, Source = source };
                    axTable.AddMethod(axMethod);

                    var tableProvider = _provider.Tables as IMetaTableProvider
                        ?? throw new InvalidOperationException("IMetaTableProvider not available");
                    tableProvider.Update(axTable, msi);

                    return new { success = true, operation = "add-method", objectType, objectName, methodName, api = "IMetaTableProvider.Update" };
                }
                case "form":
                {
                    var axForm = _provider.Forms.Read(objectName)
                        ?? throw new ArgumentException($"Form '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Forms, objectName);

                    RemoveMethodIfExists(axForm, methodName);

                    var axMethod = new AxMethod { Name = methodName, Source = source };
                    axForm.AddMethod(axMethod);

                    var formProvider = _provider.Forms as IMetaFormProvider
                        ?? throw new InvalidOperationException("IMetaFormProvider not available");
                    formProvider.Update(axForm, msi);

                    return new { success = true, operation = "add-method", objectType, objectName, methodName, api = "IMetaFormProvider.Update" };
                }
                case "query":
                {
                    var axQuery = _provider.Queries.Read(objectName)
                        ?? throw new ArgumentException($"Query '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Queries, objectName);

                    RemoveMethodIfExists(axQuery, methodName);

                    var axMethod = new AxMethod { Name = methodName, Source = source };
                    axQuery.AddMethod(axMethod);

                    var queryProvider = _provider.Queries as IMetaQueryProvider
                        ?? throw new InvalidOperationException("IMetaQueryProvider not available");
                    queryProvider.Update(axQuery, msi);

                    return new { success = true, operation = "add-method", objectType, objectName, methodName, api = "IMetaQueryProvider.Update" };
                }
                case "view":
                {
                    var axView = _provider.Views.Read(objectName)
                        ?? throw new ArgumentException($"View '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Views, objectName);

                    RemoveMethodIfExists(axView, methodName);

                    var axMethod = new AxMethod { Name = methodName, Source = source };
                    axView.AddMethod(axMethod);

                    var viewProvider = _provider.Views as IMetaViewProvider
                        ?? throw new InvalidOperationException("IMetaViewProvider not available");
                    viewProvider.Update(axView, msi);

                    return new { success = true, operation = "add-method", objectType, objectName, methodName, api = "IMetaViewProvider.Update" };
                }
                case "form-extension":
                {
                    var axExt = _provider.FormExtensions.Read(objectName)
                        ?? throw new ArgumentException($"Form extension '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.FormExtensions, objectName);

                    RemoveMethodIfExists(axExt, methodName);

                    var axMethod = new AxMethod { Name = methodName, Source = source };
                    ((dynamic)axExt).Methods.Add(axMethod);

                    ((IMetaFormExtensionProvider)_provider.FormExtensions).Update(axExt, msi);

                    return new { success = true, operation = "add-method", objectType, objectName, methodName, api = "IMetaFormExtensionProvider.Update" };
                }
                case "class-extension":
                {
                    var axClass = _provider.Classes.Read(objectName)
                        ?? throw new ArgumentException($"Class extension '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Classes, objectName);

                    RemoveMethodIfExists(axClass, methodName);

                    var axMethod = new AxMethod { Name = methodName, Source = source };
                    axClass.AddMethod(axMethod);

                    ((IMetaClassProvider)_provider.Classes).Update(axClass, msi);

                    return new { success = true, operation = "add-method", objectType, objectName, methodName, api = "IMetaClassProvider.Update" };
                }
                case "table-extension":
                {
                    var axExt = _provider.TableExtensions.Read(objectName)
                        ?? throw new ArgumentException($"Table extension '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.TableExtensions, objectName);

                    RemoveMethodIfExists(axExt, methodName);

                    var axMethod = new AxMethod { Name = methodName, Source = source };
                    ((dynamic)axExt).Methods.Add(axMethod);

                    ((IMetaTableExtensionProvider)_provider.TableExtensions).Update(axExt, msi);

                    return new { success = true, operation = "add-method", objectType, objectName, methodName, api = "IMetaTableExtensionProvider.Update" };
                }
                default:
                    throw new ArgumentException($"add-method not supported for objectType '{objectType}' via bridge (use XML fallback)");
            }
        }

        /// <summary>
        /// Adds a field to a table.
        /// Read → add field → Update.
        /// </summary>
        public object AddField(string tableName, string fieldName, string fieldType,
            string? edt, bool mandatory, string? label)
        {
            var axTable = _provider.Tables.Read(tableName)
                ?? throw new ArgumentException($"Table '{tableName}' not found");
            var msi = GetModelSaveInfoForObject(_provider.Tables, tableName);

            var param = new WriteFieldParam
            {
                Name = fieldName,
                FieldType = fieldType,
                Edt = edt,
                Mandatory = mandatory,
                Label = label
            };
            var axField = CreateTableField(param);
            axTable.AddField(axField);

            var tableProvider = _provider.Tables as IMetaTableProvider
                ?? throw new InvalidOperationException("IMetaTableProvider not available");
            tableProvider.Update(axTable, msi);

            return new { success = true, operation = "add-field", objectName = tableName, fieldName, fieldType, api = "IMetaTableProvider.Update" };
        }

        /// <summary>
        /// Sets a property on an object.
        /// Read → set property → Update.
        /// </summary>
        public object SetProperty(string objectType, string objectName, string propertyPath, string propertyValue)
        {
            switch (objectType.ToLowerInvariant())
            {
                case "class":
                {
                    var obj = _provider.Classes.Read(objectName)
                        ?? throw new ArgumentException($"Class '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Classes, objectName);
                    SetAxClassProperty(obj, propertyPath, propertyValue);
                    ((IMetaClassProvider)_provider.Classes).Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, api = "Update" };
                }
                case "table":
                {
                    var obj = _provider.Tables.Read(objectName)
                        ?? throw new ArgumentException($"Table '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Tables, objectName);
                    SetAxTableProperty(obj, propertyPath, propertyValue);
                    ((IMetaTableProvider)_provider.Tables).Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, api = "Update" };
                }
                case "enum":
                {
                    var obj = _provider.Enums.Read(objectName)
                        ?? throw new ArgumentException($"Enum '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Enums, objectName);
                    SetAxEnumProperty(obj, propertyPath, propertyValue);
                    ((IMetaEnumProvider)_provider.Enums).Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, api = "Update" };
                }
                case "edt":
                {
                    var obj = _provider.Edts.Read(objectName)
                        ?? throw new ArgumentException($"EDT '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Edts, objectName);
                    SetAxEdtProperty(obj, propertyPath, propertyValue);
                    ((IMetaEdtProvider)_provider.Edts).Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, api = "Update" };
                }
                case "query":
                {
                    var obj = _provider.Queries.Read(objectName)
                        ?? throw new ArgumentException($"Query '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Queries, objectName);
                    SetAxQueryProperty(obj, propertyPath, propertyValue);
                    ((IMetaQueryProvider)_provider.Queries).Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, api = "Update" };
                }
                case "view":
                {
                    var obj = _provider.Views.Read(objectName)
                        ?? throw new ArgumentException($"View '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Views, objectName);
                    SetAxViewProperty(obj, propertyPath, propertyValue);
                    ((IMetaViewProvider)_provider.Views).Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, api = "Update" };
                }
                case "menu-item-action":
                {
                    var obj = _provider.MenuItemActions.Read(objectName)
                        ?? throw new ArgumentException($"MenuItemAction '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.MenuItemActions, objectName);
                    SetAxMenuItemProperty(obj, propertyPath, propertyValue);
                    ((IMetaMenuItemActionProvider)_provider.MenuItemActions).Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, api = "Update" };
                }
                case "menu-item-display":
                {
                    var obj = _provider.MenuItemDisplays.Read(objectName)
                        ?? throw new ArgumentException($"MenuItemDisplay '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.MenuItemDisplays, objectName);
                    SetAxMenuItemProperty(obj, propertyPath, propertyValue);
                    ((IMetaMenuItemDisplayProvider)_provider.MenuItemDisplays).Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, api = "Update" };
                }
                case "menu-item-output":
                {
                    var obj = _provider.MenuItemOutputs.Read(objectName)
                        ?? throw new ArgumentException($"MenuItemOutput '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.MenuItemOutputs, objectName);
                    SetAxMenuItemProperty(obj, propertyPath, propertyValue);
                    ((IMetaMenuItemOutputProvider)_provider.MenuItemOutputs).Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, api = "Update" };
                }
                default:
                    throw new ArgumentException($"modify-property not supported for objectType '{objectType}' via bridge");
            }
        }

        /// <summary>
        /// Replaces text within a method source.
        /// Read → find method → string replace → Update.
        /// </summary>
        public object ReplaceCode(string objectType, string objectName, string? methodName, string oldCode, string newCode)
        {
            switch (objectType.ToLowerInvariant())
            {
                case "class":
                {
                    var obj = _provider.Classes.Read(objectName)
                        ?? throw new ArgumentException($"Class '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Classes, objectName);
                    var replaced = ReplaceInMethods(obj, methodName, oldCode, newCode);
                    if (!replaced)
                        throw new InvalidOperationException($"oldCode not found in {objectName}" + (methodName != null ? $".{methodName}" : ""));
                    ((IMetaClassProvider)_provider.Classes).Update(obj, msi);
                    return new { success = true, operation = "replace-code", objectType, objectName, methodName, api = "Update" };
                }
                case "table":
                {
                    var obj = _provider.Tables.Read(objectName)
                        ?? throw new ArgumentException($"Table '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Tables, objectName);
                    var replaced = ReplaceInMethods(obj, methodName, oldCode, newCode);
                    if (!replaced)
                        throw new InvalidOperationException($"oldCode not found in {objectName}" + (methodName != null ? $".{methodName}" : ""));
                    ((IMetaTableProvider)_provider.Tables).Update(obj, msi);
                    return new { success = true, operation = "replace-code", objectType, objectName, methodName, api = "Update" };
                }
                case "form":
                {
                    var obj = _provider.Forms.Read(objectName)
                        ?? throw new ArgumentException($"Form '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Forms, objectName);

                    // Diagnostic: log available SourceCode collections for debugging
                    try
                    {
                        dynamic dForm = obj;
                        int scMethodCount = 0, scDataControlCount = 0, scDataSourceCount = 0;
                        var dcNames = new System.Collections.Generic.List<string>();
                        try { foreach (var _ in dForm.SourceCode.Methods) scMethodCount++; } catch { }
                        try
                        {
                            foreach (dynamic dc in dForm.SourceCode.DataControls)
                            {
                                scDataControlCount++;
                                try
                                {
                                    string dcName = (string)dc.Name;
                                    int methodCount = 0;
                                    var methodNames = new System.Collections.Generic.List<string>();
                                    try { foreach (dynamic m in dc.Methods) { methodCount++; try { methodNames.Add((string)m.Name); } catch { } } } catch { }
                                    dcNames.Add($"{dcName}({string.Join(",", methodNames)})");
                                }
                                catch { dcNames.Add("?"); }
                            }
                        }
                        catch { }
                        try { foreach (var _ in dForm.SourceCode.DataSources) scDataSourceCount++; } catch { }
                        Console.Error.WriteLine($"[WriteService] ReplaceCode form '{objectName}': " +
                            $"SourceCode.Methods={scMethodCount}, DataControls={scDataControlCount}, DataSources={scDataSourceCount}, " +
                            $"methodName='{methodName}', oldCode length={oldCode.Length}");
                        if (dcNames.Count > 0)
                            Console.Error.WriteLine($"[WriteService] ReplaceCode form '{objectName}': DataControls detail: [{string.Join(", ", dcNames)}]");
                    }
                    catch (Exception diagEx)
                    {
                        Console.Error.WriteLine($"[WriteService] ReplaceCode form '{objectName}': diagnostic failed: {diagEx.Message}");
                    }

                    var replaced = ReplaceInMethods(obj, methodName, oldCode, newCode);
                    if (!replaced)
                        throw new InvalidOperationException($"oldCode not found in {objectName}" + (methodName != null ? $".{methodName}" : ""));
                    ((IMetaFormProvider)_provider.Forms).Update(obj, msi);
                    return new { success = true, operation = "replace-code", objectType, objectName, methodName, api = "Update" };
                }
                case "query":
                {
                    var obj = _provider.Queries.Read(objectName)
                        ?? throw new ArgumentException($"Query '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Queries, objectName);
                    var replaced = ReplaceInMethods(obj, methodName, oldCode, newCode);
                    if (!replaced)
                        throw new InvalidOperationException($"oldCode not found in {objectName}" + (methodName != null ? $".{methodName}" : ""));
                    ((IMetaQueryProvider)_provider.Queries).Update(obj, msi);
                    return new { success = true, operation = "replace-code", objectType, objectName, methodName, api = "Update" };
                }
                case "view":
                {
                    var obj = _provider.Views.Read(objectName)
                        ?? throw new ArgumentException($"View '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Views, objectName);
                    var replaced = ReplaceInMethods(obj, methodName, oldCode, newCode);
                    if (!replaced)
                        throw new InvalidOperationException($"oldCode not found in {objectName}" + (methodName != null ? $".{methodName}" : ""));
                    ((IMetaViewProvider)_provider.Views).Update(obj, msi);
                    return new { success = true, operation = "replace-code", objectType, objectName, methodName, api = "Update" };
                }
                case "form-extension":
                {
                    var obj = _provider.FormExtensions.Read(objectName)
                        ?? throw new ArgumentException($"Form extension '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.FormExtensions, objectName);
                    var replaced = ReplaceInMethods(obj, methodName, oldCode, newCode);
                    if (!replaced)
                        throw new InvalidOperationException($"oldCode not found in {objectName}" + (methodName != null ? $".{methodName}" : ""));
                    ((IMetaFormExtensionProvider)_provider.FormExtensions).Update(obj, msi);
                    return new { success = true, operation = "replace-code", objectType, objectName, methodName, api = "Update" };
                }
                case "class-extension":
                {
                    var obj = _provider.Classes.Read(objectName)
                        ?? throw new ArgumentException($"Class extension '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Classes, objectName);
                    var replaced = ReplaceInMethods(obj, methodName, oldCode, newCode);
                    if (!replaced)
                        throw new InvalidOperationException($"oldCode not found in {objectName}" + (methodName != null ? $".{methodName}" : ""));
                    ((IMetaClassProvider)_provider.Classes).Update(obj, msi);
                    return new { success = true, operation = "replace-code", objectType, objectName, methodName, api = "Update" };
                }
                case "table-extension":
                {
                    var obj = _provider.TableExtensions.Read(objectName)
                        ?? throw new ArgumentException($"Table extension '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.TableExtensions, objectName);
                    var replaced = ReplaceInMethods(obj, methodName, oldCode, newCode);
                    if (!replaced)
                        throw new InvalidOperationException($"oldCode not found in {objectName}" + (methodName != null ? $".{methodName}" : ""));
                    ((IMetaTableExtensionProvider)_provider.TableExtensions).Update(obj, msi);
                    return new { success = true, operation = "replace-code", objectType, objectName, methodName, api = "Update" };
                }
                default:
                    throw new ArgumentException($"replace-code not supported for objectType '{objectType}' via bridge");
            }
        }

        // ========================
        // REMOVE METHOD
        // ========================

        /// <summary>
        /// Removes a method from a class, table, form, query, or view.
        /// Read → remove method → Update.
        /// </summary>
        public object RemoveMethod(string objectType, string objectName, string methodName)
        {
            switch (objectType.ToLowerInvariant())
            {
                case "class":
                {
                    var obj = _provider.Classes.Read(objectName)
                        ?? throw new ArgumentException($"Class '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Classes, objectName);
                    if (!RemoveMethodByName(obj, methodName))
                        throw new InvalidOperationException($"Method '{methodName}' not found on class '{objectName}'");
                    ((IMetaClassProvider)_provider.Classes).Update(obj, msi);
                    return new { success = true, operation = "remove-method", objectType, objectName, methodName, api = "IMetaClassProvider.Update" };
                }
                case "table":
                {
                    var obj = _provider.Tables.Read(objectName)
                        ?? throw new ArgumentException($"Table '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Tables, objectName);
                    if (!RemoveMethodByName(obj, methodName))
                        throw new InvalidOperationException($"Method '{methodName}' not found on table '{objectName}'");
                    ((IMetaTableProvider)_provider.Tables).Update(obj, msi);
                    return new { success = true, operation = "remove-method", objectType, objectName, methodName, api = "IMetaTableProvider.Update" };
                }
                case "form":
                {
                    var obj = _provider.Forms.Read(objectName)
                        ?? throw new ArgumentException($"Form '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Forms, objectName);
                    if (!RemoveMethodByName(obj, methodName))
                        throw new InvalidOperationException($"Method '{methodName}' not found on form '{objectName}'");
                    ((IMetaFormProvider)_provider.Forms).Update(obj, msi);
                    return new { success = true, operation = "remove-method", objectType, objectName, methodName, api = "IMetaFormProvider.Update" };
                }
                case "query":
                {
                    var obj = _provider.Queries.Read(objectName)
                        ?? throw new ArgumentException($"Query '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Queries, objectName);
                    if (!RemoveMethodByName(obj, methodName))
                        throw new InvalidOperationException($"Method '{methodName}' not found on query '{objectName}'");
                    ((IMetaQueryProvider)_provider.Queries).Update(obj, msi);
                    return new { success = true, operation = "remove-method", objectType, objectName, methodName, api = "IMetaQueryProvider.Update" };
                }
                case "view":
                {
                    var obj = _provider.Views.Read(objectName)
                        ?? throw new ArgumentException($"View '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Views, objectName);
                    if (!RemoveMethodByName(obj, methodName))
                        throw new InvalidOperationException($"Method '{methodName}' not found on view '{objectName}'");
                    ((IMetaViewProvider)_provider.Views).Update(obj, msi);
                    return new { success = true, operation = "remove-method", objectType, objectName, methodName, api = "IMetaViewProvider.Update" };
                }
                case "form-extension":
                {
                    var obj = _provider.FormExtensions.Read(objectName)
                        ?? throw new ArgumentException($"Form extension '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.FormExtensions, objectName);
                    if (!RemoveMethodByName(obj, methodName))
                        throw new InvalidOperationException($"Method '{methodName}' not found on form extension '{objectName}'");
                    ((IMetaFormExtensionProvider)_provider.FormExtensions).Update(obj, msi);
                    return new { success = true, operation = "remove-method", objectType, objectName, methodName, api = "IMetaFormExtensionProvider.Update" };
                }
                case "class-extension":
                {
                    var obj = _provider.Classes.Read(objectName)
                        ?? throw new ArgumentException($"Class extension '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Classes, objectName);
                    if (!RemoveMethodByName(obj, methodName))
                        throw new InvalidOperationException($"Method '{methodName}' not found on class extension '{objectName}'");
                    ((IMetaClassProvider)_provider.Classes).Update(obj, msi);
                    return new { success = true, operation = "remove-method", objectType, objectName, methodName, api = "IMetaClassProvider.Update" };
                }
                case "table-extension":
                {
                    var obj = _provider.TableExtensions.Read(objectName)
                        ?? throw new ArgumentException($"Table extension '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.TableExtensions, objectName);
                    if (!RemoveMethodByName(obj, methodName))
                        throw new InvalidOperationException($"Method '{methodName}' not found on table extension '{objectName}'");
                    ((IMetaTableExtensionProvider)_provider.TableExtensions).Update(obj, msi);
                    return new { success = true, operation = "remove-method", objectType, objectName, methodName, api = "IMetaTableExtensionProvider.Update" };
                }
                default:
                    throw new ArgumentException($"remove-method not supported for objectType '{objectType}' via bridge");
            }
        }

        // ========================
        // TABLE INDEX OPERATIONS
        // ========================

        /// <summary>Adds an index to a table.</summary>
        public object AddIndex(string tableName, string indexName, List<string>? fields, bool allowDuplicates, bool alternateKey)
        {
            var axTable = _provider.Tables.Read(tableName)
                ?? throw new ArgumentException($"Table '{tableName}' not found");
            var msi = GetModelSaveInfoForObject(_provider.Tables, tableName);

            var axIdx = new AxTableIndex { Name = indexName };
            axIdx.AllowDuplicates = allowDuplicates ? Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.Yes : Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.No;
            if (alternateKey)
                axIdx.AlternateKey = Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.Yes;
            if (fields != null)
            {
                foreach (var f in fields)
                    axIdx.AddField(new AxTableIndexField { DataField = f });
            }
            axTable.AddIndex(axIdx);

            ((IMetaTableProvider)_provider.Tables).Update(axTable, msi);
            return new { success = true, operation = "add-index", objectName = tableName, indexName, fieldCount = fields?.Count ?? 0, api = "IMetaTableProvider.Update" };
        }

        /// <summary>Removes an index from a table.</summary>
        public object RemoveIndex(string tableName, string indexName)
        {
            var axTable = _provider.Tables.Read(tableName)
                ?? throw new ArgumentException($"Table '{tableName}' not found");
            var msi = GetModelSaveInfoForObject(_provider.Tables, tableName);

            AxTableIndex? toRemove = null;
            foreach (AxTableIndex idx in axTable.Indexes)
            {
                if (string.Equals(idx.Name, indexName, StringComparison.OrdinalIgnoreCase))
                { toRemove = idx; break; }
            }
            if (toRemove == null)
                throw new InvalidOperationException($"Index '{indexName}' not found on table '{tableName}'");
            axTable.Indexes.Remove(toRemove);

            ((IMetaTableProvider)_provider.Tables).Update(axTable, msi);
            return new { success = true, operation = "remove-index", objectName = tableName, indexName, api = "IMetaTableProvider.Update" };
        }

        // ========================
        // TABLE RELATION OPERATIONS
        // ========================

        /// <summary>Adds a relation to a table.</summary>
        public object AddRelation(string tableName, string relationName, string relatedTable, List<WriteRelationConstraint>? constraints)
        {
            var axTable = _provider.Tables.Read(tableName)
                ?? throw new ArgumentException($"Table '{tableName}' not found");
            var msi = GetModelSaveInfoForObject(_provider.Tables, tableName);

            var axRel = new AxTableRelation { Name = relationName, RelatedTable = relatedTable };
            if (constraints != null)
            {
                foreach (var c in constraints)
                {
                    axRel.AddConstraint(new AxTableRelationConstraintField
                    {
                        Name = c.Field ?? "",
                        Field = c.Field ?? "",
                        RelatedField = c.RelatedField ?? ""
                    });
                }
            }
            axTable.AddRelation(axRel);

            ((IMetaTableProvider)_provider.Tables).Update(axTable, msi);
            return new { success = true, operation = "add-relation", objectName = tableName, relationName, relatedTable, api = "IMetaTableProvider.Update" };
        }

        /// <summary>Removes a relation from a table.</summary>
        public object RemoveRelation(string tableName, string relationName)
        {
            var axTable = _provider.Tables.Read(tableName)
                ?? throw new ArgumentException($"Table '{tableName}' not found");
            var msi = GetModelSaveInfoForObject(_provider.Tables, tableName);

            AxTableRelation? toRemove = null;
            foreach (AxTableRelation rel in axTable.Relations)
            {
                if (string.Equals(rel.Name, relationName, StringComparison.OrdinalIgnoreCase))
                { toRemove = rel; break; }
            }
            if (toRemove == null)
                throw new InvalidOperationException($"Relation '{relationName}' not found on table '{tableName}'");
            axTable.Relations.Remove(toRemove);

            ((IMetaTableProvider)_provider.Tables).Update(axTable, msi);
            return new { success = true, operation = "remove-relation", objectName = tableName, relationName, api = "IMetaTableProvider.Update" };
        }

        // ========================
        // TABLE FIELD GROUP OPERATIONS
        // ========================

        /// <summary>Adds a field group to a table.</summary>
        public object AddFieldGroup(string tableName, string groupName, string? label, List<string>? fields)
        {
            var axTable = _provider.Tables.Read(tableName)
                ?? throw new ArgumentException($"Table '{tableName}' not found");
            var msi = GetModelSaveInfoForObject(_provider.Tables, tableName);

            var axFg = new AxTableFieldGroup { Name = groupName };
            if (!string.IsNullOrEmpty(label)) axFg.Label = label;
            if (fields != null)
            {
                foreach (var fieldRef in fields)
                    axFg.AddField(new AxTableFieldGroupField { DataField = fieldRef });
            }
            axTable.AddFieldGroup(axFg);

            ((IMetaTableProvider)_provider.Tables).Update(axTable, msi);
            return new { success = true, operation = "add-field-group", objectName = tableName, groupName, fieldCount = fields?.Count ?? 0, api = "IMetaTableProvider.Update" };
        }

        /// <summary>Removes a field group from a table.</summary>
        public object RemoveFieldGroup(string tableName, string groupName)
        {
            var axTable = _provider.Tables.Read(tableName)
                ?? throw new ArgumentException($"Table '{tableName}' not found");
            var msi = GetModelSaveInfoForObject(_provider.Tables, tableName);

            AxTableFieldGroup? toRemove = null;
            foreach (AxTableFieldGroup fg in axTable.FieldGroups)
            {
                if (string.Equals(fg.Name, groupName, StringComparison.OrdinalIgnoreCase))
                { toRemove = fg; break; }
            }
            if (toRemove == null)
                throw new InvalidOperationException($"Field group '{groupName}' not found on table '{tableName}'");
            axTable.FieldGroups.Remove(toRemove);

            ((IMetaTableProvider)_provider.Tables).Update(axTable, msi);
            return new { success = true, operation = "remove-field-group", objectName = tableName, groupName, api = "IMetaTableProvider.Update" };
        }

        /// <summary>Adds a field reference to an existing field group on a table.</summary>
        public object AddFieldToFieldGroup(string tableName, string groupName, string fieldName)
        {
            var axTable = _provider.Tables.Read(tableName)
                ?? throw new ArgumentException($"Table '{tableName}' not found");
            var msi = GetModelSaveInfoForObject(_provider.Tables, tableName);

            AxTableFieldGroup? targetFg = null;
            foreach (AxTableFieldGroup fg in axTable.FieldGroups)
            {
                if (string.Equals(fg.Name, groupName, StringComparison.OrdinalIgnoreCase))
                { targetFg = fg; break; }
            }
            if (targetFg == null)
                throw new InvalidOperationException($"Field group '{groupName}' not found on table '{tableName}'");

            targetFg.AddField(new AxTableFieldGroupField { DataField = fieldName });

            ((IMetaTableProvider)_provider.Tables).Update(axTable, msi);
            return new { success = true, operation = "add-field-to-field-group", objectName = tableName, groupName, fieldName, api = "IMetaTableProvider.Update" };
        }

        // ========================
        // TABLE FIELD MODIFY / RENAME / REMOVE / REPLACE-ALL
        // ========================

        /// <summary>Modifies properties of an existing field on a table.</summary>
        public object ModifyField(string tableName, string fieldName, Dictionary<string, string>? properties)
        {
            var axTable = _provider.Tables.Read(tableName)
                ?? throw new ArgumentException($"Table '{tableName}' not found");
            var msi = GetModelSaveInfoForObject(_provider.Tables, tableName);

            AxTableField? target = null;
            foreach (AxTableField f in axTable.Fields)
            {
                if (string.Equals(f.Name, fieldName, StringComparison.OrdinalIgnoreCase))
                { target = f; break; }
            }
            if (target == null)
                throw new InvalidOperationException($"Field '{fieldName}' not found on table '{tableName}'");

            if (properties != null)
            {
                foreach (var kv in properties)
                    SetTableFieldProperty(target, kv.Key, kv.Value);
            }

            ((IMetaTableProvider)_provider.Tables).Update(axTable, msi);
            return new { success = true, operation = "modify-field", objectName = tableName, fieldName, api = "IMetaTableProvider.Update" };
        }

        /// <summary>
        /// Renames a field on a table. Also fixes index DataField refs and TitleField1/2.
        /// </summary>
        public object RenameField(string tableName, string oldName, string newName)
        {
            var axTable = _provider.Tables.Read(tableName)
                ?? throw new ArgumentException($"Table '{tableName}' not found");
            var msi = GetModelSaveInfoForObject(_provider.Tables, tableName);

            AxTableField? target = null;
            foreach (AxTableField f in axTable.Fields)
            {
                if (string.Equals(f.Name, oldName, StringComparison.OrdinalIgnoreCase))
                { target = f; break; }
            }
            if (target == null)
                throw new InvalidOperationException($"Field '{oldName}' not found on table '{tableName}'");

            target.Name = newName;

            // Fix index DataField references
            foreach (AxTableIndex idx in axTable.Indexes)
            {
                foreach (AxTableIndexField ixf in idx.Fields)
                {
                    if (string.Equals(ixf.DataField, oldName, StringComparison.OrdinalIgnoreCase))
                        ixf.DataField = newName;
                }
            }

            // Fix TitleField1/2
            if (string.Equals(axTable.TitleField1, oldName, StringComparison.OrdinalIgnoreCase))
                axTable.TitleField1 = newName;
            if (string.Equals(axTable.TitleField2, oldName, StringComparison.OrdinalIgnoreCase))
                axTable.TitleField2 = newName;

            // Fix field group references
            foreach (AxTableFieldGroup fg in axTable.FieldGroups)
            {
                foreach (AxTableFieldGroupField fgf in fg.Fields)
                {
                    if (string.Equals(fgf.DataField, oldName, StringComparison.OrdinalIgnoreCase))
                        fgf.DataField = newName;
                }
            }

            ((IMetaTableProvider)_provider.Tables).Update(axTable, msi);
            return new { success = true, operation = "rename-field", objectName = tableName, oldName, newName, api = "IMetaTableProvider.Update" };
        }

        /// <summary>Removes a field from a table.</summary>
        public object RemoveField(string tableName, string fieldName)
        {
            var axTable = _provider.Tables.Read(tableName)
                ?? throw new ArgumentException($"Table '{tableName}' not found");
            var msi = GetModelSaveInfoForObject(_provider.Tables, tableName);

            AxTableField? toRemove = null;
            foreach (AxTableField f in axTable.Fields)
            {
                if (string.Equals(f.Name, fieldName, StringComparison.OrdinalIgnoreCase))
                { toRemove = f; break; }
            }
            if (toRemove == null)
                throw new InvalidOperationException($"Field '{fieldName}' not found on table '{tableName}'");
            axTable.Fields.Remove(toRemove);

            ((IMetaTableProvider)_provider.Tables).Update(axTable, msi);
            return new { success = true, operation = "remove-field", objectName = tableName, fieldName, api = "IMetaTableProvider.Update" };
        }

        /// <summary>Replaces ALL fields on a table (clear + re-add). Use for bulk field rewrite.</summary>
        public object ReplaceAllFields(string tableName, List<WriteFieldParam> fields)
        {
            var axTable = _provider.Tables.Read(tableName)
                ?? throw new ArgumentException($"Table '{tableName}' not found");
            var msi = GetModelSaveInfoForObject(_provider.Tables, tableName);

            // Clear existing fields
            var existing = new List<AxTableField>();
            foreach (AxTableField f in axTable.Fields) existing.Add(f);
            foreach (var f in existing) axTable.Fields.Remove(f);

            // Add new fields
            foreach (var fp in fields)
            {
                var axField = CreateTableField(fp);
                axTable.AddField(axField);
            }

            ((IMetaTableProvider)_provider.Tables).Update(axTable, msi);
            return new { success = true, operation = "replace-all-fields", objectName = tableName, fieldCount = fields.Count, api = "IMetaTableProvider.Update" };
        }

        // ========================
        // ENUM VALUE OPERATIONS
        // ========================

        /// <summary>Adds a value to an enum.</summary>
        public object AddEnumValue(string enumName, string valueName, int value, string? label)
        {
            var axEnum = _provider.Enums.Read(enumName)
                ?? throw new ArgumentException($"Enum '{enumName}' not found");
            var msi = GetModelSaveInfoForObject(_provider.Enums, enumName);

            var axVal = new AxEnumValue { Name = valueName, Value = value };
            if (!string.IsNullOrEmpty(label)) axVal.Label = label;
            axEnum.AddEnumValue(axVal);

            ((IMetaEnumProvider)_provider.Enums).Update(axEnum, msi);
            return new { success = true, operation = "add-enum-value", objectName = enumName, valueName, value, api = "IMetaEnumProvider.Update" };
        }

        /// <summary>Modifies properties of an existing enum value.</summary>
        public object ModifyEnumValue(string enumName, string valueName, Dictionary<string, string>? properties)
        {
            var axEnum = _provider.Enums.Read(enumName)
                ?? throw new ArgumentException($"Enum '{enumName}' not found");
            var msi = GetModelSaveInfoForObject(_provider.Enums, enumName);

            AxEnumValue? target = null;
            foreach (AxEnumValue v in axEnum.EnumValues)
            {
                if (string.Equals(v.Name, valueName, StringComparison.OrdinalIgnoreCase))
                { target = v; break; }
            }
            if (target == null)
                throw new InvalidOperationException($"Enum value '{valueName}' not found on enum '{enumName}'");

            if (properties != null)
            {
                foreach (var kv in properties)
                {
                    switch (kv.Key.ToLowerInvariant())
                    {
                        case "label": target.Label = kv.Value; break;
                        case "value":
                            if (int.TryParse(kv.Value, out var iv)) target.Value = iv;
                            break;
                    }
                }
            }

            ((IMetaEnumProvider)_provider.Enums).Update(axEnum, msi);
            return new { success = true, operation = "modify-enum-value", objectName = enumName, valueName, api = "IMetaEnumProvider.Update" };
        }

        /// <summary>Removes a value from an enum.</summary>
        public object RemoveEnumValue(string enumName, string valueName)
        {
            var axEnum = _provider.Enums.Read(enumName)
                ?? throw new ArgumentException($"Enum '{enumName}' not found");
            var msi = GetModelSaveInfoForObject(_provider.Enums, enumName);

            AxEnumValue? toRemove = null;
            foreach (AxEnumValue v in axEnum.EnumValues)
            {
                if (string.Equals(v.Name, valueName, StringComparison.OrdinalIgnoreCase))
                { toRemove = v; break; }
            }
            if (toRemove == null)
                throw new InvalidOperationException($"Enum value '{valueName}' not found on enum '{enumName}'");
            axEnum.EnumValues.Remove(toRemove);

            ((IMetaEnumProvider)_provider.Enums).Update(axEnum, msi);
            return new { success = true, operation = "remove-enum-value", objectName = enumName, valueName, api = "IMetaEnumProvider.Update" };
        }

        // ========================
        // TABLE-EXTENSION: ADD FIELD MODIFICATION
        // ========================

        /// <summary>
        /// Adds or updates a FieldModification entry in a table-extension.
        /// Allows overriding Label / Mandatory on a base-table field.
        /// SDK does not expose FieldModifications collection statically — use fully dynamic access.
        /// </summary>
        public object AddFieldModification(string extensionName, string fieldName,
            string? fieldLabel, bool? fieldMandatory)
        {
            var axExt = _provider.TableExtensions.Read(extensionName)
                ?? throw new ArgumentException($"Table extension '{extensionName}' not found");
            var msi = GetModelSaveInfoForObject(_provider.TableExtensions, extensionName);

            // AxTableExtension.FieldModifications and the element type are not always
            // statically available — use fully dynamic access (same pattern as Methods).
            dynamic dynExt = axExt;
            dynamic fmCollection = dynExt.FieldModifications;

            // Check if a modification for this field already exists
            dynamic? existing = null;
            foreach (dynamic fm in fmCollection)
            {
                if (string.Equals((string)fm.Name, fieldName, StringComparison.OrdinalIgnoreCase))
                { existing = fm; break; }
            }

            if (existing == null)
            {
                // Create new field modification entry — use the element type from the collection
                var assembly = typeof(AxClass).Assembly;
                // Try known type names: AxTableFieldModification, AxTableExtensionFieldModification
                Type? fmType = assembly.GetType("Microsoft.Dynamics.AX.Metadata.MetaModel.AxTableFieldModification")
                    ?? assembly.GetType("Microsoft.Dynamics.AX.Metadata.MetaModel.AxTableExtensionFieldModification");
                if (fmType == null)
                {
                    // Fallback: discover from collection's generic type argument
                    var collType = fmCollection.GetType();
                    if (collType.IsGenericType)
                    {
                        var args = collType.GetGenericArguments();
                        if (args.Length > 0) fmType = args[0];
                    }
                }
                if (fmType == null)
                    throw new InvalidOperationException("Cannot determine FieldModification element type — use xmlContent fallback");

                existing = Activator.CreateInstance(fmType)!;
                existing.Name = fieldName;
                fmCollection.Add(existing);
            }

            if (fieldLabel != null) existing.Label = fieldLabel;
            if (fieldMandatory.HasValue)
                existing.Mandatory = fieldMandatory.Value
                    ? Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.Yes
                    : Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.No;

            ((IMetaTableExtensionProvider)_provider.TableExtensions).Update(axExt, msi);
            return new { success = true, operation = "add-field-modification", objectName = extensionName, fieldName,
                fieldLabel, fieldMandatory, api = "IMetaTableExtensionProvider.Update" };
        }

        // ========================
        // MENU: ADD MENU ITEM TO MENU
        // ========================

        /// <summary>
        /// Adds a menu item reference to an existing menu.
        /// Menu element types may differ from standalone AxMenuItemXxx — use dynamic discovery.
        /// </summary>
        public object AddMenuItemToMenu(string menuName, string menuItemName, string menuItemType)
        {
            var axMenu = _provider.Menus.Read(menuName)
                ?? throw new ArgumentException($"Menu '{menuName}' not found");
            var msi = GetModelSaveInfoForObject(_provider.Menus, menuName);

            // Use dynamic dispatch — AxMenu.MenuItems hierarchy varies by SDK version.
            // Menu element items are NOT the standalone AxMenuItemDisplay/Action/Output types;
            // they are AxMenuElementMenuItem* types (or similar).
            dynamic dynMenu = axMenu;

            var itemType = (menuItemType ?? "display").ToLowerInvariant();
            var assembly = typeof(AxClass).Assembly;

            // Discover the correct element type for menu item references
            string[] candidateTypeNames = itemType switch
            {
                "display" => new[] {
                    "Microsoft.Dynamics.AX.Metadata.MetaModel.AxMenuElementMenuItemDisplay",
                    "Microsoft.Dynamics.AX.Metadata.MetaModel.AxMenuItemDisplayReference" },
                "action" => new[] {
                    "Microsoft.Dynamics.AX.Metadata.MetaModel.AxMenuElementMenuItemAction",
                    "Microsoft.Dynamics.AX.Metadata.MetaModel.AxMenuItemActionReference" },
                "output" => new[] {
                    "Microsoft.Dynamics.AX.Metadata.MetaModel.AxMenuElementMenuItemOutput",
                    "Microsoft.Dynamics.AX.Metadata.MetaModel.AxMenuItemOutputReference" },
                _ => throw new ArgumentException($"Unsupported menu item type: '{menuItemType}'. Use 'display', 'action', or 'output'."),
            };

            Type? elementType = null;
            foreach (var name in candidateTypeNames)
            {
                elementType = assembly.GetType(name);
                if (elementType != null) break;
            }

            // Last resort: iterate MenuItems to find element base type, then find subclass for our item type
            if (elementType == null)
            {
                // Try to get the collection's generic argument as the base type
                dynamic menuItems = dynMenu.MenuItems;
                var collType = ((object)menuItems).GetType();
                if (collType.IsGenericType)
                {
                    var baseElemType = collType.GetGenericArguments()[0];
                    // Find a subclass whose name contains "display"/"action"/"output"
                    elementType = assembly.GetTypes()
                        .FirstOrDefault(t => baseElemType.IsAssignableFrom(t) && !t.IsAbstract
                            && t.Name.IndexOf(itemType, StringComparison.OrdinalIgnoreCase) >= 0);
                }
            }

            if (elementType == null)
                throw new InvalidOperationException($"Cannot determine menu element type for '{itemType}' — use xmlContent fallback");

            dynamic menuItem = Activator.CreateInstance(elementType)!;
            menuItem.Name = menuItemName;
            dynMenu.MenuItems.Add(menuItem);

            ((IMetaMenuProvider)_provider.Menus).Update(axMenu, msi);
            return new { success = true, operation = "add-menu-item-to-menu", objectName = menuName, menuItemName, menuItemType = itemType, api = "IMetaMenuProvider.Update" };
        }

        // ========================
        // FORM: ADD CONTROL / ADD DATA SOURCE
        // ========================

        /// <summary>
        /// Adds a control to a form. Navigates to parentControl and inserts a new child control.
        /// </summary>
        public object AddControl(string formName, string controlName, string parentControl,
            string controlType, string? dataSource, string? dataField, string? label)
        {
            var axForm = _provider.Forms.Read(formName)
                ?? throw new ArgumentException($"Form '{formName}' not found");
            var msi = GetModelSaveInfoForObject(_provider.Forms, formName);

            // Navigate to parent control in the design tree
            var design = axForm.Design;
            var parent = FindControlRecursive(design, parentControl);
            if (parent == null)
                throw new InvalidOperationException($"Parent control '{parentControl}' not found in form '{formName}'");

            // Create the control using reflection (AxFormControl is abstract)
            var control = CreateFormControl(controlType, controlName, dataSource, dataField, label);
            AddChildControl(parent, control);

            ((IMetaFormProvider)_provider.Forms).Update(axForm, msi);
            return new { success = true, operation = "add-control", objectName = formName, controlName, parentControl, controlType, api = "IMetaFormProvider.Update" };
        }

        /// <summary>
        /// Adds a data source to a form or query.
        /// </summary>
        public object AddDataSource(string objectType, string objectName, string dsName, string table,
            string? joinSource, string? linkType)
        {
            switch (objectType.ToLowerInvariant())
            {
                case "form":
                {
                    var axForm = _provider.Forms.Read(objectName)
                        ?? throw new ArgumentException($"Form '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Forms, objectName);

                    // AxFormDataSource hierarchy is abstract — find concrete type via reflection
                    // (same pattern as CreateFormControl for abstract AxFormControl types)
                    var assembly = typeof(AxClass).Assembly;
                    var dsType = assembly.GetTypes()
                        .FirstOrDefault(t => typeof(AxFormDataSourceConcrete).IsAssignableFrom(t) && !t.IsAbstract)
                        ?? throw new InvalidOperationException(
                            "No concrete AxFormDataSource type found in metadata assembly — use xmlContent fallback");
                    dynamic ds = Activator.CreateInstance(dsType)!;
                    ds.Name = dsName;
                    ds.Table = table;
                    if (!string.IsNullOrEmpty(joinSource)) ds.JoinSource = joinSource;
                    axForm.AddDataSource((AxFormDataSourceConcrete)ds);

                    ((IMetaFormProvider)_provider.Forms).Update(axForm, msi);
                    return new { success = true, operation = "add-data-source", objectType, objectName, dsName, table, api = "IMetaFormProvider.Update" };
                }
                default:
                    throw new ArgumentException($"add-data-source not supported for objectType '{objectType}' via bridge");
            }
        }

        // ========================
        // HELPERS: Table Field Creation
        // ========================

        private AxTableField CreateTableField(WriteFieldParam f)
        {
            AxTableField axField;
            var fieldType = (f.FieldType ?? "String").ToLowerInvariant();

            switch (fieldType)
            {
                case "string":
                    var sf = new AxTableFieldString();
                    if (f.StringSize > 0) sf.StringSize = f.StringSize;
                    axField = sf;
                    break;
                case "integer":
                case "int":
                    axField = new AxTableFieldInt();
                    break;
                case "real":
                    axField = new AxTableFieldReal();
                    break;
                case "date":
                    axField = new AxTableFieldDate();
                    break;
                case "utcdatetime":
                case "datetime":
                    axField = new AxTableFieldUtcDateTime();
                    break;
                case "int64":
                    axField = new AxTableFieldInt64();
                    break;
                case "enum":
                    var ef = new AxTableFieldEnum();
                    if (!string.IsNullOrEmpty(f.EnumType)) ef.EnumType = f.EnumType;
                    axField = ef;
                    break;
                case "container":
                    axField = new AxTableFieldContainer();
                    break;
                case "guid":
                    axField = new AxTableFieldGuid();
                    break;
                default:
                    axField = new AxTableFieldString();
                    break;
            }

            axField.Name = f.Name;
            if (!string.IsNullOrEmpty(f.Edt)) axField.ExtendedDataType = f.Edt;
            if (!string.IsNullOrEmpty(f.Label)) axField.Label = f.Label;
            if (!string.IsNullOrEmpty(f.HelpText)) axField.HelpText = f.HelpText;
            if (f.Mandatory)
                axField.Mandatory = Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.Yes;

            return axField;
        }

        // ========================
        // HELPERS: Property Setters
        // ========================

        private void SetAxClassProperty(AxClass cls, string prop, string value)
        {
            switch (prop.ToLowerInvariant())
            {
                case "extends": cls.Extends = value; break;
                case "isabstract": cls.IsAbstract = ParseBool(value); break;
                case "isfinal": cls.IsFinal = ParseBool(value); break;
                default:
                    Console.Error.WriteLine($"[WriteService] Unknown AxClass property: {prop}");
                    break;
            }
        }

        private void SetAxTableProperty(AxTable tbl, string prop, string value)
        {
            switch (prop.ToLowerInvariant())
            {
                case "label": tbl.Label = value; break;
                case "developerdocumentation": tbl.DeveloperDocumentation = value; break;
                case "tablegroup":
                    if (Enum.TryParse<Microsoft.Dynamics.AX.Metadata.Core.MetaModel.TableGroup>(value, true, out var tg))
                        tbl.TableGroup = tg;
                    break;
                case "cachelookup":
                    if (Enum.TryParse<Microsoft.Dynamics.AX.Metadata.Core.MetaModel.RecordCacheLevel>(value, true, out var cl))
                        tbl.CacheLookup = cl;
                    break;
                case "clusteredindex": tbl.ClusteredIndex = value; break;
                case "primaryindex": tbl.PrimaryIndex = value; break;
                case "savedatapercompany":
                    tbl.SaveDataPerCompany = ParseNoYes(value);
                    break;
                case "tabletype":
                    if (Enum.TryParse<Microsoft.Dynamics.AX.Metadata.Core.MetaModel.TableType>(value, true, out var tt))
                        tbl.TableType = tt;
                    break;
                case "supportinheritance":
                    tbl.SupportInheritance = ParseNoYes(value);
                    break;
                case "extends": tbl.Extends = value; break;
                case "titlefield1": tbl.TitleField1 = value; break;
                case "titlefield2": tbl.TitleField2 = value; break;
                default:
                    Console.Error.WriteLine($"[WriteService] Unknown AxTable property: {prop}");
                    break;
            }
        }

        private void SetAxEnumProperty(AxEnum en, string prop, string value)
        {
            switch (prop.ToLowerInvariant())
            {
                case "label": en.Label = value; break;
                case "isextensible":
                    en.IsExtensible = ParseBool(value);
                    break;
                default:
                    Console.Error.WriteLine($"[WriteService] Unknown AxEnum property: {prop}");
                    break;
            }
        }

        private void SetAxEdtProperty(AxEdt edt, string prop, string value)
        {
            switch (prop.ToLowerInvariant())
            {
                case "label": edt.Label = value; break;
                case "helptext": edt.HelpText = value; break;
                case "extends": edt.Extends = value; break;
                case "stringsize":
                    if (edt is AxEdtString strEdt && int.TryParse(value, out var ss)) strEdt.StringSize = ss;
                    break;
                case "referencetable": edt.ReferenceTable = value; break;
                case "basetype": break; // handled at construction time
                default:
                    Console.Error.WriteLine($"[WriteService] Unknown AxEdt property: {prop}");
                    break;
            }
        }

        private void SetAxQueryProperty(AxQuery q, string prop, string value)
        {
            // AxQuery is abstract — properties may vary by subclass. Use dynamic for safety.
            dynamic dq = q;
            switch (prop.ToLowerInvariant())
            {
                case "title":
                    try { dq.Title = value; } catch { Console.Error.WriteLine($"[WriteService] AxQuery.Title not available on this subclass"); }
                    break;
                case "description":
                    try { dq.Description = value; } catch { Console.Error.WriteLine($"[WriteService] AxQuery.Description not available on this subclass"); }
                    break;
                case "allowcrosscompany":
                    try { dq.AllowCrossCompany = ParseNoYes(value); } catch { Console.Error.WriteLine($"[WriteService] AxQuery.AllowCrossCompany not available"); }
                    break;
                default:
                    Console.Error.WriteLine($"[WriteService] Unknown AxQuery property: {prop}");
                    break;
            }
        }

        private void SetAxViewProperty(AxView v, string prop, string value)
        {
            switch (prop.ToLowerInvariant())
            {
                case "label": v.Label = value; break;
                case "developerdocumentation": v.DeveloperDocumentation = value; break;
                default:
                    Console.Error.WriteLine($"[WriteService] Unknown AxView property: {prop}");
                    break;
            }
        }

        /// <summary>
        /// Shared property setter for all three menu item types (Action, Display, Output).
        /// AxMenuItemAction/Display/Output all inherit from AxMenuItem which shares these properties.
        /// </summary>
        private void SetAxMenuItemProperty(dynamic mi, string prop, string value)
        {
            switch (prop.ToLowerInvariant())
            {
                case "label": mi.Label = value; break;
                case "helptext": mi.HelpText = value; break;
                case "object": mi.Object = value; break;
                case "objecttype":
                    if (Enum.TryParse<Microsoft.Dynamics.AX.Metadata.Core.MetaModel.MenuItemObjectType>(value, true, out var ot))
                        mi.ObjectType = ot;
                    break;
                case "openmode":
                    if (Enum.TryParse<Microsoft.Dynamics.AX.Metadata.Core.MetaModel.OpenMode>(value, true, out var om))
                        mi.OpenMode = om;
                    break;
                case "normalimage": mi.NormalImage = value; break;
                case "imagelocation":
                    // ImageLocation enum type varies across D365FO versions — skip for safety
                    Console.Error.WriteLine($"[WriteService] ImageLocation not directly supported — use modify-property after creation");
                    break;
                case "configurationkey": mi.ConfigurationKey = value; break;
                case "countryregioncodes": mi.CountryRegionCodes = value; break;
                case "maintainuserauthorization":
                    mi.MaintainUserAuthorization = ParseNoYes(value);
                    break;
                default:
                    Console.Error.WriteLine($"[WriteService] Unknown AxMenuItem property: {prop}");
                    break;
            }
        }

        private void SetAxSecurityPrivilegeProperty(AxSecurityPrivilege priv, string prop, string value)
        {
            switch (prop.ToLowerInvariant())
            {
                case "label": priv.Label = value; break;
                case "description": priv.Description = value; break;
                default:
                    Console.Error.WriteLine($"[WriteService] Unknown AxSecurityPrivilege property: {prop}");
                    break;
            }
        }

        private void SetAxSecurityDutyProperty(AxSecurityDuty duty, string prop, string value)
        {
            switch (prop.ToLowerInvariant())
            {
                case "label": duty.Label = value; break;
                case "description": duty.Description = value; break;
                default:
                    Console.Error.WriteLine($"[WriteService] Unknown AxSecurityDuty property: {prop}");
                    break;
            }
        }

        private void SetAxSecurityRoleProperty(AxSecurityRole role, string prop, string value)
        {
            switch (prop.ToLowerInvariant())
            {
                case "label": role.Label = value; break;
                case "description": role.Description = value; break;
                default:
                    Console.Error.WriteLine($"[WriteService] Unknown AxSecurityRole property: {prop}");
                    break;
            }
        }

        // ========================
        // HELPERS: Method Operations
        // ========================

        /// <summary>
        /// Removes a method by name from an AxClass or AxTable (both have a Methods collection).
        /// Uses dynamic because the Methods property is not on a shared interface.
        /// For forms/form-extensions, also checks SourceCode.Methods and SourceCode.DataControls.
        /// </summary>
        private void RemoveMethodIfExists(object axObject, string methodName)
        {
            // Try top-level Methods first (AxClass, AxTable, AxTableExtension, etc.)
            if (TryRemoveFromCollection(axObject, "Methods", methodName)) return;

            // For forms: SourceCode.Methods (form-level methods like init, run)
            try
            {
                dynamic dyn = axObject;
                dynamic sourceCode = dyn.SourceCode;
                if (sourceCode != null && TryRemoveFromCollection(sourceCode, "Methods", methodName)) return;
            }
            catch { }

            // For forms: SourceCode.DataControls (control override methods)
            try
            {
                dynamic dyn = axObject;
                dynamic sourceCode = dyn.SourceCode;
                if (sourceCode != null && TryRemoveFromCollection(sourceCode, "DataControls", methodName)) return;
            }
            catch { }
        }

        /// <summary>
        /// Removes a method by name, returning true if found and removed.
        /// For forms/form-extensions, also checks SourceCode.Methods and SourceCode.DataControls.
        /// </summary>
        private bool RemoveMethodByName(object axObject, string methodName)
        {
            // Try top-level Methods first (AxClass, AxTable, etc.)
            if (TryRemoveFromCollection(axObject, "Methods", methodName)) return true;

            // For forms: SourceCode.Methods
            try
            {
                dynamic dyn = axObject;
                dynamic sourceCode = dyn.SourceCode;
                if (sourceCode != null && TryRemoveFromCollection(sourceCode, "Methods", methodName)) return true;
            }
            catch { }

            // For forms: SourceCode.DataControls
            try
            {
                dynamic dyn = axObject;
                dynamic sourceCode = dyn.SourceCode;
                if (sourceCode != null && TryRemoveFromCollection(sourceCode, "DataControls", methodName)) return true;
            }
            catch { }

            return false;
        }

        /// <summary>
        /// Tries to remove a method by Name from a named collection on the given object.
        /// Returns true if found and removed. Catches silently if the collection doesn't exist.
        /// </summary>
        private bool TryRemoveFromCollection(object parentObj, string collectionName, string methodName)
        {
            try
            {
                var prop = parentObj.GetType().GetProperty(collectionName);
                if (prop == null) return false;
                dynamic collection = prop.GetValue(parentObj);
                if (collection == null) return false;

                // Find the method to remove
                dynamic? toRemove = null;
                foreach (dynamic m in collection)
                {
                    string mName = (string)m.Name;
                    if (string.Equals(mName, methodName, StringComparison.OrdinalIgnoreCase))
                    {
                        toRemove = m;
                        break;
                    }
                }
                if (toRemove != null)
                {
                    collection.Remove(toRemove);
                    return true;
                }
                return false;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WriteService] TryRemoveFromCollection({collectionName}, {methodName}) failed: {ex.Message}");
                return false;
            }
        }

        /// <summary>Sets a property on an existing table field.</summary>
        private void SetTableFieldProperty(AxTableField field, string prop, string value)
        {
            switch (prop.ToLowerInvariant())
            {
                case "label": field.Label = value; break;
                case "helptext": field.HelpText = value; break;
                case "mandatory":
                    field.Mandatory = ParseNoYes(value);
                    break;
                case "allowedit":
                    field.AllowEdit = ParseNoYes(value);
                    break;
                case "extendeddatatype":
                case "edt":
                    field.ExtendedDataType = value;
                    break;
                case "stringsize":
                    if (field is AxTableFieldString sf && int.TryParse(value, out var ss)) sf.StringSize = ss;
                    break;
                case "enumtype":
                    if (field is AxTableFieldEnum ef) ef.EnumType = value;
                    break;
                default:
                    Console.Error.WriteLine($"[WriteService] Unknown table field property: {prop}");
                    break;
            }
        }

        /// <summary>
        /// Recursively finds a control in the form design tree by name.
        /// Returns the dynamic control object (AxFormControl subclass).
        /// </summary>
        private dynamic? FindControlRecursive(dynamic container, string controlName)
        {
            try
            {
                // Try container.Controls (design and container controls have this)
                var controls = container.Controls;
                if (controls != null)
                {
                    foreach (dynamic c in controls)
                    {
                        string cName = c.Name;
                        if (string.Equals(cName, controlName, StringComparison.OrdinalIgnoreCase))
                            return c;
                        var found = FindControlRecursive(c, controlName);
                        if (found != null) return found;
                    }
                }
            }
            catch { /* container has no Controls property */ }
            return null;
        }

        /// <summary>Creates a form control of the specified type.</summary>
        private dynamic CreateFormControl(string controlType, string controlName,
            string? dataSource, string? dataField, string? label)
        {
            // Use reflection to find AxFormControl* types in the metadata assembly
            var assembly = typeof(AxClass).Assembly;
            string typeName = $"Microsoft.Dynamics.AX.Metadata.MetaModel.AxFormControl{controlType}";
            var ctrlType = assembly.GetType(typeName);

            // Fallback: try common type names
            if (ctrlType == null)
            {
                var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                {
                    ["String"] = "AxFormControlString",
                    ["Integer"] = "AxFormControlInteger",
                    ["Real"] = "AxFormControlReal",
                    ["Date"] = "AxFormControlDate",
                    ["DateTime"] = "AxFormControlDateTime",
                    ["Int64"] = "AxFormControlInt64",
                    ["CheckBox"] = "AxFormControlCheckBox",
                    ["ComboBox"] = "AxFormControlComboBox",
                    ["Group"] = "AxFormControlGroup",
                    ["Button"] = "AxFormControlButton",
                    ["Grid"] = "AxFormControlGrid",
                    ["Tab"] = "AxFormControlTab",
                    ["TabPage"] = "AxFormControlTabPage",
                    ["Image"] = "AxFormControlImage",
                    ["ActionPane"] = "AxFormControlActionPane",
                    ["ActionPaneTab"] = "AxFormControlActionPaneTab",
                    ["ButtonGroup"] = "AxFormControlButtonGroup",
                };
                if (map.TryGetValue(controlType, out var mapped))
                    ctrlType = assembly.GetType($"Microsoft.Dynamics.AX.Metadata.MetaModel.{mapped}");
            }

            if (ctrlType == null)
                throw new ArgumentException($"Unknown form control type: '{controlType}' — no matching AxFormControl type found");

            dynamic ctrl = Activator.CreateInstance(ctrlType)!;
            ctrl.Name = controlName;
            if (!string.IsNullOrEmpty(dataSource))
            {
                try { ctrl.DataSource = dataSource; } catch { }
            }
            if (!string.IsNullOrEmpty(dataField))
            {
                try { ctrl.DataField = dataField; } catch { }
            }
            if (!string.IsNullOrEmpty(label))
            {
                try { ctrl.Label = label; } catch { }
            }
            return ctrl;
        }

        /// <summary>Adds a child control to a container control (design, group, tab, etc.).</summary>
        private void AddChildControl(dynamic parent, dynamic child)
        {
            try
            {
                parent.Controls.Add(child);
            }
            catch
            {
                try { parent.AddControl(child); }
                catch (Exception ex)
                {
                    throw new InvalidOperationException($"Cannot add control to '{parent.Name}': {ex.Message}");
                }
            }
        }

        /// <summary>
        /// Replaces oldCode with newCode in method sources. If methodName is specified, only that method.
        /// Returns true if at least one replacement was made.
        /// </summary>
        private bool ReplaceInMethods(object axObject, string? methodName, string oldCode, string newCode)
        {
            try
            {
                dynamic dyn = axObject;
                bool replaced = false;

                // Parse "ControlName.methodName" syntax for scoping to a specific form control override.
                // E.g. methodName="PostButton.clicked" → controlNameFilter="PostButton", effectiveMethodName="clicked"
                string? controlNameFilter = null;
                string? effectiveMethodName = methodName;
                if (methodName != null && methodName.Contains('.'))
                {
                    var dotIdx = methodName.IndexOf('.');
                    controlNameFilter = methodName.Substring(0, dotIdx);
                    effectiveMethodName = methodName.Substring(dotIdx + 1);
                }

                // Check declaration first (for classDeclaration scope, only when not targeting a control)
                if (controlNameFilter == null &&
                    (methodName == null || methodName.Equals("classDeclaration", StringComparison.OrdinalIgnoreCase)))
                {
                    try
                    {
                        string decl = dyn.Declaration;
                        if (decl != null && decl.Contains(oldCode))
                        {
                            dyn.Declaration = decl.Replace(oldCode, newCode);
                            replaced = true;
                        }
                    }
                    catch { /* some objects may not have Declaration */ }
                }

                // Check top-level methods (skip entirely when scoped to a specific control)
                if (controlNameFilter == null)
                {
                    // Standard objects: dyn.Methods (AxClass, AxTable, AxQuery, AxView, extensions)
                    try
                    {
                        foreach (AxMethod m in dyn.Methods)
                        {
                            if (effectiveMethodName != null && !string.Equals(m.Name, effectiveMethodName, StringComparison.OrdinalIgnoreCase))
                                continue;

                            if (m.Source != null && m.Source.Contains(oldCode))
                            {
                                m.Source = m.Source.Replace(oldCode, newCode);
                                replaced = true;
                            }
                        }
                    }
                    catch { /* object may not have a top-level Methods collection */ }

                    // Forms store methods under SourceCode.Methods (not top-level Methods)
                    try
                    {
                        foreach (dynamic m in dyn.SourceCode.Methods)
                        {
                            string mName = (string)m.Name;
                            if (effectiveMethodName != null && !string.Equals(mName, effectiveMethodName, StringComparison.OrdinalIgnoreCase))
                                continue;

                            string? src = (string?)m.Source;
                            if (src != null && src.Contains(oldCode))
                            {
                                m.Source = src.Replace(oldCode, newCode);
                                replaced = true;
                            }
                        }
                    }
                    catch { /* object may not have SourceCode.Methods (non-form objects) */ }
                }

                // Control override methods in forms are stored under SourceCode.DataControls.
                // Each DataControl item is a CONTROL object (Name = control name, e.g. "PostButton")
                // which contains a Methods collection (each with Name = method name, e.g. "clicked", and Source).
                // SDK structure:  SourceCode.DataControls → [ { Name: "PostButton", Methods: [{ Name: "clicked", Source: "..." }] } ]
                try
                {
                    foreach (dynamic ctrl in dyn.SourceCode.DataControls)
                    {
                        try
                        {
                            string ctrlName = (string)ctrl.Name;
                            bool controlMatches = controlNameFilter == null ||
                                string.Equals(ctrlName, controlNameFilter, StringComparison.OrdinalIgnoreCase);

                            if (!controlMatches) continue;

                            // Iterate methods inside this control
                            try
                            {
                                foreach (dynamic m in ctrl.Methods)
                                {
                                    try
                                    {
                                        string mName = (string)m.Name;
                                        bool methodMatches = effectiveMethodName == null ||
                                            string.Equals(mName, effectiveMethodName, StringComparison.OrdinalIgnoreCase);

                                        if (methodMatches)
                                        {
                                            string? src = (string?)m.Source;
                                            if (src != null && src.Contains(oldCode))
                                            {
                                                m.Source = src.Replace(oldCode, newCode);
                                                replaced = true;
                                                Console.Error.WriteLine($"[WriteService] ReplaceInMethods: replaced in DataControl '{ctrlName}'.'{mName}'");
                                            }
                                        }
                                    }
                                    catch { }
                                }
                            }
                            catch { /* control may not have Methods */ }

                            // Fallback: some SDK versions may expose Source directly on the DataControl item
                            // (for cases where control name IS the method name, e.g. flat override list)
                            if (!replaced)
                            {
                                try
                                {
                                    string? directSrc = (string?)ctrl.Source;
                                    if (directSrc != null && directSrc.Contains(oldCode))
                                    {
                                        ctrl.Source = directSrc.Replace(oldCode, newCode);
                                        replaced = true;
                                        Console.Error.WriteLine($"[WriteService] ReplaceInMethods: replaced via direct Source on DataControl '{ctrlName}'");
                                    }
                                }
                                catch { }
                            }
                        }
                        catch { }
                    }
                }
                catch { /* object may not have SourceCode.DataControls (non-form objects) */ }

                // Also try Design.Controls hierarchy — some SDK versions may expose methods on control objects
                try { replaced |= ReplaceInControls(dyn.Design, controlNameFilter, effectiveMethodName, oldCode, newCode); } catch { }
                try { replaced |= ReplaceInControls(dyn, controlNameFilter, effectiveMethodName, oldCode, newCode); } catch { }

                // Last resort: if still not found and we have a combined methodName, try the full
                // "ControlName.methodName" as a single method name in SourceCode.Methods (some forms)
                if (!replaced && controlNameFilter != null && effectiveMethodName != null)
                {
                    try
                    {
                        foreach (dynamic m in dyn.SourceCode.Methods)
                        {
                            string mName = (string)m.Name;
                            string combinedUnderscore = $"{controlNameFilter}_{effectiveMethodName}";
                            if (string.Equals(mName, combinedUnderscore, StringComparison.OrdinalIgnoreCase)
                             || string.Equals(mName, methodName, StringComparison.OrdinalIgnoreCase))
                            {
                                string? src = (string?)m.Source;
                                if (src != null && src.Contains(oldCode))
                                {
                                    m.Source = src.Replace(oldCode, newCode);
                                    replaced = true;
                                }
                            }
                        }
                    }
                    catch { }
                }

                // Absolute last resort: scan ALL reachable Source properties for oldCode (no method name filter)
                // This handles edge cases where the SDK stores the code in an unexpected location.
                if (!replaced)
                {
                    replaced = ReplaceCodeInXmlFallback(dyn, oldCode, newCode);
                }

                return replaced;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WriteService] ReplaceInMethods failed: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// Recursively searches all Controls in a form or form-extension object for override methods
        /// matching the given filter constraints, and replaces oldCode with newCode in their Source.
        /// Supports "ControlName.methodName" scoping via controlNameFilter + methodNameFilter.
        /// Safe to call on non-form objects — if they have no Controls collection, returns false silently.
        /// </summary>
        private bool ReplaceInControls(dynamic parent, string? controlNameFilter, string? methodNameFilter,
            string oldCode, string newCode)
        {
            bool replaced = false;
            try
            {
                foreach (dynamic control in parent.Controls)
                {
                    try
                    {
                        string controlName = (string)control.Name;
                        bool controlMatches = controlNameFilter == null ||
                            string.Equals(controlName, controlNameFilter, StringComparison.OrdinalIgnoreCase);

                        if (controlMatches)
                        {
                            // Try multiple property names for override methods:
                            // - OverrideMethods (some SDK versions)
                            // - Methods (other SDK versions / form controls)
                            replaced |= ReplaceInMethodCollection(control, "OverrideMethods", methodNameFilter, oldCode, newCode);
                            replaced |= ReplaceInMethodCollection(control, "Methods", methodNameFilter, oldCode, newCode);
                        }

                        // Recurse into nested controls regardless — a matching control may be nested in a group
                        replaced |= ReplaceInControls(control, controlNameFilter, methodNameFilter, oldCode, newCode);
                    }
                    catch { }
                }
            }
            catch { /* object has no Controls collection; silently skip */ }
            return replaced;
        }

        /// <summary>
        /// Iterates a named method collection on a dynamic object and replaces oldCode with newCode.
        /// Returns true if at least one replacement was made. Silently returns false if the collection
        /// doesn't exist on the object.
        /// </summary>
        private bool ReplaceInMethodCollection(dynamic obj, string collectionName, string? methodNameFilter,
            string oldCode, string newCode)
        {
            bool replaced = false;
            try
            {
                var prop = ((object)obj).GetType().GetProperty(collectionName);
                if (prop == null) return false;
                dynamic? collection = prop.GetValue(obj);
                if (collection == null) return false;

                foreach (dynamic m in collection)
                {
                    try
                    {
                        if (methodNameFilter != null &&
                            !string.Equals((string)m.Name, methodNameFilter, StringComparison.OrdinalIgnoreCase))
                            continue;

                        string? src = (string?)m.Source;
                        if (src != null && src.Contains(oldCode))
                        {
                            m.Source = src.Replace(oldCode, newCode);
                            replaced = true;
                        }
                    }
                    catch { }
                }
            }
            catch { }
            return replaced;
        }

        /// <summary>
        /// Absolute last-resort fallback: enumerate all iterable collections exposed by SourceCode
        /// (Methods, DataSources, DataControls, Members) and any nested items looking for Source
        /// properties that contain oldCode. Replaces globally. Used when structured access fails.
        /// For DataControls, also iterates into each control's Methods sub-collection.
        /// </summary>
        private bool ReplaceCodeInXmlFallback(dynamic axObject, string oldCode, string newCode)
        {
            bool replaced = false;
            try
            {
                // Try all known sub-collections on SourceCode
                dynamic? sourceCode = null;
                try { sourceCode = axObject.SourceCode; } catch { return false; }
                if (sourceCode == null) return false;

                string[] collectionNames = { "Methods", "DataSources", "Members" };
                foreach (var colName in collectionNames)
                {
                    try
                    {
                        var prop = ((object)sourceCode).GetType().GetProperty(colName);
                        if (prop == null) continue;
                        dynamic? collection = prop.GetValue(sourceCode);
                        if (collection == null) continue;

                        foreach (dynamic item in collection)
                        {
                            try
                            {
                                string? src = null;
                                try { src = (string?)item.Source; } catch { }
                                if (src != null && src.Contains(oldCode))
                                {
                                    item.Source = src.Replace(oldCode, newCode);
                                    replaced = true;
                                    Console.Error.WriteLine($"[WriteService] ReplaceCodeInXmlFallback: replaced in SourceCode.{colName} item '{(string?)item.Name ?? "?"}'");
                                }
                            }
                            catch { }
                        }
                    }
                    catch { }
                }

                // DataControls are special: each item is a control with nested Methods
                try
                {
                    var dcProp = ((object)sourceCode).GetType().GetProperty("DataControls");
                    if (dcProp != null)
                    {
                        dynamic? dcCollection = dcProp.GetValue(sourceCode);
                        if (dcCollection != null)
                        {
                            foreach (dynamic ctrl in dcCollection)
                            {
                                try
                                {
                                    string ctrlName = "?";
                                    try { ctrlName = (string)ctrl.Name; } catch { }

                                    // Try methods inside control
                                    try
                                    {
                                        foreach (dynamic m in ctrl.Methods)
                                        {
                                            try
                                            {
                                                string? src = (string?)m.Source;
                                                if (src != null && src.Contains(oldCode))
                                                {
                                                    m.Source = src.Replace(oldCode, newCode);
                                                    replaced = true;
                                                    Console.Error.WriteLine($"[WriteService] ReplaceCodeInXmlFallback: replaced in DataControls.{ctrlName}.{(string?)m.Name ?? "?"}");
                                                }
                                            }
                                            catch { }
                                        }
                                    }
                                    catch { }

                                    // Also try direct Source on control object (flat override lists)
                                    try
                                    {
                                        string? src = (string?)ctrl.Source;
                                        if (src != null && src.Contains(oldCode))
                                        {
                                            ctrl.Source = src.Replace(oldCode, newCode);
                                            replaced = true;
                                            Console.Error.WriteLine($"[WriteService] ReplaceCodeInXmlFallback: replaced direct Source on DataControl '{ctrlName}'");
                                        }
                                    }
                                    catch { }
                                }
                                catch { }
                            }
                        }
                    }
                }
                catch { }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WriteService] ReplaceCodeInXmlFallback failed: {ex.Message}");
            }
            return replaced;
        }

        // ========================
        // HELPERS: Model Info Resolution for Existing Objects
        // ========================

        /// <summary>
        /// Gets ModelSaveInfo for an existing object by asking the provider for its model info.
        /// The generic IReadOnlySingleKeyedMetadataProvider does NOT expose GetModelInfo —
        /// it lives on concrete provider interfaces (IMetaClassProvider, IMetaTableProvider, etc.).
        /// We try dynamic dispatch first, then fall back to concrete provider properties,
        /// and finally try to infer from the on-disk file path.
        /// </summary>
        private ModelSaveInfo GetModelSaveInfoForObject<T>(IReadOnlySingleKeyedMetadataProvider<T> collection, string objectName)
            where T : class
        {
            // Strategy 1: dynamic dispatch on the collection object (works if runtime type exposes GetModelInfo)
            try
            {
                dynamic dynCollection = collection;
                var modelInfos = dynCollection.GetModelInfo(objectName);
                if (modelInfos != null)
                {
                    foreach (ModelInfo mi in modelInfos)
                    {
                        return new ModelSaveInfo { Id = mi.Id, Layer = mi.Layer };
                    }
                }
            }
            catch { /* GetModelInfo not found on this interface — continue to fallback */ }

            // Strategy 2: try all concrete provider properties that have GetModelInfo
            ModelInfo? foundMi = TryGetModelInfoFromProviders(objectName);
            if (foundMi != null)
            {
                return new ModelSaveInfo { Id = foundMi.Id, Layer = foundMi.Layer };
            }

            // Strategy 3: infer model from on-disk file path
            //   Files live at {packagesPath}/{ModelName}/{ModelName}/Ax{Type}/{Name}.xml
            //   We scan common AOT folders for the object name.
            string[] aotFolders = { "AxClass", "AxTable", "AxForm", "AxEnum", "AxEdt",
                                    "AxQuery", "AxView", "AxDataEntityView", "AxReport",
                                    "AxTableExtension", "AxFormExtension", "AxClassExtension",
                                    "AxEnumExtension" };
            try
            {
                foreach (var packageDir in Directory.GetDirectories(_packagesPath))
                {
                    var packageName = Path.GetFileName(packageDir);
                    foreach (var aotFolder in aotFolders)
                    {
                        var filePath = Path.Combine(packageDir, packageName, aotFolder, objectName + ".xml");
                        if (File.Exists(filePath))
                        {
                            // Found the file — resolve model from this package name
                            var msi = ResolveModelSaveInfo(packageName);
                            if (msi != null)
                            {
                                Console.Error.WriteLine($"[WriteService] GetModelSaveInfoForObject: resolved '{objectName}' via file path → model '{packageName}'");
                                return msi;
                            }
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WriteService] GetModelSaveInfoForObject file scan failed for {objectName}: {ex.Message}");
            }

            throw new InvalidOperationException($"Cannot determine model for existing object '{objectName}'");
        }

        /// <summary>
        /// Tries GetModelInfo on all known concrete provider properties.
        /// Returns the first ModelInfo found, or null.
        /// </summary>
        private ModelInfo? TryGetModelInfoFromProviders(string objectName)
        {
            // Each provider property (Classes, Tables, etc.) has GetModelInfo on its concrete type
            try { var mi = _provider.Classes.GetModelInfo(objectName); if (mi?.Count > 0) return mi.First(); } catch { }
            try { var mi = _provider.Tables.GetModelInfo(objectName); if (mi?.Count > 0) return mi.First(); } catch { }
            try { var mi = _provider.Forms.GetModelInfo(objectName); if (mi?.Count > 0) return mi.First(); } catch { }
            try { var mi = _provider.Enums.GetModelInfo(objectName); if (mi?.Count > 0) return mi.First(); } catch { }
            try { var mi = _provider.Edts.GetModelInfo(objectName); if (mi?.Count > 0) return mi.First(); } catch { }
            try { var mi = _provider.Queries.GetModelInfo(objectName); if (mi?.Count > 0) return mi.First(); } catch { }
            try { var mi = _provider.Views.GetModelInfo(objectName); if (mi?.Count > 0) return mi.First(); } catch { }
            try { var mi = _provider.FormExtensions.GetModelInfo(objectName); if (mi?.Count > 0) return mi.First(); } catch { }
            try { var mi = _provider.TableExtensions.GetModelInfo(objectName); if (mi?.Count > 0) return mi.First(); } catch { }
            try { var mi = _provider.EnumExtensions.GetModelInfo(objectName); if (mi?.Count > 0) return mi.First(); } catch { }
            try { var mi = _provider.Reports.GetModelInfo(objectName); if (mi?.Count > 0) return mi.First(); } catch { }
            return null;
        }

        // ========================
        // HELPERS: Path + Parse
        // ========================

        private string GetExpectedPath(string aotFolder, string objectName, string modelName)
        {
            return Path.Combine(_packagesPath, modelName, modelName, aotFolder, objectName + ".xml");
        }

        private static bool ParseBool(string value)
        {
            return value.Equals("true", StringComparison.OrdinalIgnoreCase)
                || value.Equals("Yes", StringComparison.OrdinalIgnoreCase)
                || value == "1";
        }

        private static Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes ParseNoYes(string value)
        {
            return ParseBool(value)
                ? Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.Yes
                : Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.No;
        }
    }

    // ========================
    // PARAMETER MODELS (for JSON deserialization from TypeScript)
    // ========================

    public class WriteMethodParam
    {
        [System.Text.Json.Serialization.JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [System.Text.Json.Serialization.JsonPropertyName("source")]
        public string? Source { get; set; }
    }

    public class WriteFieldParam
    {
        [System.Text.Json.Serialization.JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [System.Text.Json.Serialization.JsonPropertyName("fieldType")]
        public string? FieldType { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("edt")]
        public string? Edt { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("enumType")]
        public string? EnumType { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("mandatory")]
        public bool Mandatory { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("label")]
        public string? Label { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("helpText")]
        public string? HelpText { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("stringSize")]
        public int StringSize { get; set; }
    }

    public class WriteFieldGroupParam
    {
        [System.Text.Json.Serialization.JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [System.Text.Json.Serialization.JsonPropertyName("label")]
        public string? Label { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("fields")]
        public List<string>? Fields { get; set; }
    }

    public class WriteIndexParam
    {
        [System.Text.Json.Serialization.JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [System.Text.Json.Serialization.JsonPropertyName("allowDuplicates")]
        public bool AllowDuplicates { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("alternateKey")]
        public bool AlternateKey { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("fields")]
        public List<string>? Fields { get; set; }
    }

    public class WriteRelationParam
    {
        [System.Text.Json.Serialization.JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [System.Text.Json.Serialization.JsonPropertyName("relatedTable")]
        public string? RelatedTable { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("constraints")]
        public List<WriteRelationConstraint>? Constraints { get; set; }
    }

    public class WriteRelationConstraint
    {
        [System.Text.Json.Serialization.JsonPropertyName("field")]
        public string? Field { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("relatedField")]
        public string? RelatedField { get; set; }
    }

    public class WriteEnumValueParam
    {
        [System.Text.Json.Serialization.JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [System.Text.Json.Serialization.JsonPropertyName("value")]
        public int Value { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("label")]
        public string? Label { get; set; }
    }
}
