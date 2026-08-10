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

        // Cache the publisher verdict per model name — see IsMicrosoftModel. Cleared with
        // _modelCache in UpdateProvider for the same reason: it is read off the provider.
        private readonly Dictionary<string, bool> _microsoftModelCache = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);

        public MetadataWriteService(IMetadataProvider provider, string packagesPath)
        {
            _provider = provider;
            _packagesPath = packagesPath;
        }

        /// <summary>
        /// Called by MetadataReadService.RefreshProvider() to keep the write service in sync.
        ///
        /// The model cache is derived from the provider (ResolveModelSaveInfo asks
        /// _provider.ModelManifest first), so it cannot outlive it. A model the OLD manifest
        /// did not enumerate — the usual case for a model that was just deployed, or created
        /// and not yet built — falls back to the descriptor scan, whose ModelSaveInfo carries
        /// the SequenceId as Id and SequenceId=0; that is exactly the shape that makes
        /// IMetadataProvider.Create() throw NullReferenceException. Cached, it survived every
        /// later refresh, so the refresh that finally made the manifest able to answer
        /// correctly changed nothing and every subsequent create into that model kept NREing.
        /// </summary>
        public void UpdateProvider(IMetadataProvider newProvider)
        {
            _provider = newProvider;
            _modelCache.Clear();
            _microsoftModelCache.Clear();
        }

        // ========================
        // MODEL RESOLUTION
        // ========================

        /// <summary>
        /// Resolves a model name to ModelSaveInfo.
        ///
        /// PREFERRED: the provider's model manifest, which gives the model's real runtime
        /// identity — the small ordinal Id AND the SequenceId. This matters because the
        /// model descriptor's &lt;Id&gt; element is actually the SequenceId (a large number);
        /// parsing it into ModelSaveInfo.Id while leaving SequenceId=0 makes
        /// IMetadataProvider.Create() throw NullReferenceException. (Verified: a custom model's
        /// manifest Id=116 SequenceId=896000930 creates fine; descriptor-derived Id=896000930
        /// SequenceId=0 NREs.) The descriptor scan stays as a fallback for models the
        /// manifest does not enumerate (e.g. not yet built/registered).
        /// Caches results for repeated calls.
        /// </summary>
        public ModelSaveInfo? ResolveModelSaveInfo(string modelName)
        {
            if (_modelCache.TryGetValue(modelName, out var cached))
                return cached;

            // Preferred: authoritative identity from the runtime model manifest.
            var fromManifest = ResolveModelSaveInfoFromManifest(modelName);
            if (fromManifest != null) { _modelCache[modelName] = fromManifest; return fromManifest; }

            // Fallback: descriptor scan. Note the Id/SequenceId caveat above — this path
            // can yield a ModelSaveInfo the create API rejects, but it is the best we can do
            // when the model is absent from the manifest.
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

        /// <summary>
        /// Resolves ModelSaveInfo from the provider's model manifest by model name, capturing
        /// the real runtime Id + SequenceId (see ResolveModelSaveInfo remarks). Returns null
        /// when the model is not enumerated by the manifest.
        /// </summary>
        private ModelSaveInfo? ResolveModelSaveInfoFromManifest(string modelName)
        {
            try
            {
                var manifest = _provider.ModelManifest;
                if (manifest == null) return null;
                foreach (var mi in manifest.ListModelInfos())
                {
                    if (string.Equals(mi.Name, modelName, StringComparison.OrdinalIgnoreCase))
                        return new ModelSaveInfo { Id = mi.Id, Layer = mi.Layer, Name = mi.Name, SequenceId = mi.SequenceId };
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WriteService] Manifest model lookup failed for '{modelName}': {ex.Message}");
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

                if (!int.TryParse(idEl.Value, out int id) || !int.TryParse(layerEl.Value, out int layer))
                {
                    Console.Error.WriteLine($"[WriteService] Invalid numeric Id or Layer in descriptor {xmlPath}: Id='{idEl.Value}' Layer='{layerEl.Value}'");
                    return null;
                }

                // Name is REQUIRED for Create: the SDK routes a brand-new object to its
                // model folder via ModelSaveInfo.Name. Leaving it null is why createObject
                // threw NullReferenceException while modify (Update) — which already knows
                // the existing object's location — worked fine.
                return new ModelSaveInfo
                {
                    Id = id,
                    Layer = layer,
                    Name = targetModelName
                };
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WriteService] Error parsing descriptor {xmlPath}: {ex.Message}");
                return null;
            }
        }

        // ========================
        // MODEL OWNERSHIP
        // ========================

        /// <summary>
        /// Is this model shipped by Microsoft?
        ///
        /// Answered from the model manifest's Publisher, which is the model's own
        /// declaration of who owns it — not a name list that goes stale with every
        /// release, and not the layer (a partner solution can sit in a low layer).
        ///
        /// Default-allow on purpose: an unreadable manifest, or a model the manifest
        /// does not enumerate, answers false. A guard that cannot see the evidence must
        /// not start refusing writes that work today; the cost of the rare miss is the
        /// behaviour we already had, while a false positive would block a customer's own
        /// model with no way around it from inside the tool.
        /// </summary>
        private bool IsMicrosoftModel(string? modelName)
        {
            if (string.IsNullOrWhiteSpace(modelName)) return false;
            if (_microsoftModelCache.TryGetValue(modelName!, out var cached)) return cached;

            var isMicrosoft = false;
            try
            {
                var manifest = _provider.ModelManifest;
                if (manifest != null)
                {
                    foreach (var mi in manifest.ListModelInfos())
                    {
                        if (!string.Equals(mi.Name, modelName, StringComparison.OrdinalIgnoreCase)) continue;
                        isMicrosoft = (mi.Publisher ?? "").IndexOf("Microsoft", StringComparison.OrdinalIgnoreCase) >= 0;
                        break;
                    }
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WriteService] Publisher lookup failed for model '{modelName}': {ex.Message}");
            }

            _microsoftModelCache[modelName!] = isMicrosoft;
            return isMicrosoft;
        }

        /// <summary>
        /// Refuses a write into a Microsoft-shipped model.
        ///
        /// The bridge resolves its target by NAME and writes wherever that name lives, so
        /// nothing about a request distinguishes "modify my object" from "modify the base
        /// application". The TS modify path checks ownership from the resolved FILE path,
        /// but that is a different resolution than the one the bridge performs and it is
        /// not on every route into these methods (batchModify, a direct RPC). This is the
        /// check at the point of the actual write.
        /// </summary>
        private void AssertModelWritable(ModelSaveInfo? msi, string operation, string objectName, string alternative)
        {
            if (msi == null || !IsMicrosoftModel(msi.Name)) return;
            throw new InvalidOperationException(
                $"Refusing {operation} on '{objectName}': it belongs to Microsoft-shipped model '{msi.Name}'. " +
                $"Writing into the base application is not repeatable — the next platform update overwrites it. {alternative}");
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

            // Apply table-level properties (Label, TableGroup, CacheLookup, etc.).
            // Finding #35: an unknown key was dropped in silence — report it instead.
            var unsupportedProperties = new List<string>();
            if (properties != null)
            {
                foreach (var kv in properties)
                    if (!SetAxTableProperty(axTable, kv.Key, kv.Value))
                        unsupportedProperties.Add(kv.Key);
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
                    foreach (var ixf in RequireIndexFields(name, ix.Name, ix.Fields))
                    {
                        var axIxField = new AxTableIndexField { DataField = ixf };
                        axIdx.AddField(axIxField);
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
                    foreach (var c in RequireRelationConstraints(name, rel.Name, rel.Constraints))
                        axRel.AddConstraint(NewRelationConstraint(rel.Name, c));
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
            return new
            {
                success = true, objectType = "table", objectName = name, modelName, filePath,
                api = "IMetaTableProvider.Create",
                appliedProperties = (properties?.Keys ?? Enumerable.Empty<string>())
                    .Where(k => !unsupportedProperties.Contains(k)).ToList(),
                unsupportedProperties,
            };
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
                    foreach (var ixf in RequireIndexFields(name, ix.Name, ix.Fields))
                        axIdx.AddField(new AxTableIndexField { DataField = ixf });
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
                    foreach (var c in RequireRelationConstraints(name, rel.Name, rel.Constraints))
                        axRel.AddConstraint(NewRelationConstraint(rel.Name, c));
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
            // Finding #35: the return value used to be thrown away, so an unknown key
            // (configurationKey, …) produced a stderr line nobody reads and a ✅ to the
            // caller. Collect what did NOT apply and report it in the response.
            var unsupportedProperties = new List<string>();
            if (extraProperties != null)
            {
                foreach (var kv in extraProperties)
                    if (!SetAxTableProperty(axTable, kv.Key, kv.Value))
                        unsupportedProperties.Add(kv.Key);
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
                appliedProperties = (extraProperties?.Keys ?? Enumerable.Empty<string>())
                    .Where(k => !unsupportedProperties.Contains(k)).ToList(),
                unsupportedProperties,
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
                    if (!string.IsNullOrEmpty(v.CountryRegionCodes)) axVal.CountryRegionCodes = v.CountryRegionCodes;
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

            // stringSize on a non-string base type is the common miss here (see
            // SetAxEdtProperty): the EDT is created either way, so report the drop rather
            // than fail the create — but do not let it pass as applied.
            var unsupportedProperties = new List<string>();
            if (properties != null)
            {
                foreach (var kv in properties)
                    if (!SetAxEdtProperty(axEdt, kv.Key, kv.Value))
                        unsupportedProperties.Add(kv.Key);
            }

            var edtProvider = _provider.Edts as IMetaEdtProvider
                ?? throw new InvalidOperationException("DiskProvider.Edts does not implement IMetaEdtProvider");
            edtProvider.Create(axEdt, msi);

            var filePath = GetExpectedPath("AxEdt", name, modelName);
            return new { success = true, objectType = "edt", objectName = name, modelName, filePath, unsupportedProperties, api = "IMetaEdtProvider.Create" };
        }

        /// <summary>
        /// Creates a new Query object via IMetaQueryProvider.
        /// AxQuery is abstract — use AxQuerySimple (concrete subclass) for creation.
        /// </summary>
        public object CreateQuery(string name, string modelName, Dictionary<string, string>? properties)
        {
            var msi = ResolveModelSaveInfo(modelName)
                ?? throw new ArgumentException($"Model '{modelName}' not found in {_packagesPath}");

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

            // The concrete subclass decides which of these exist at all (SetAxQueryProperty),
            // so what could not be written is part of the answer.
            var unsupportedProperties = new List<string>();
            if (properties != null)
            {
                foreach (var kv in properties)
                    if (!SetAxQueryProperty(axQuery, kv.Key, kv.Value))
                        unsupportedProperties.Add(kv.Key);
            }

            var queryProvider = _provider.Queries as IMetaQueryProvider
                ?? throw new InvalidOperationException("DiskProvider.Queries does not implement IMetaQueryProvider");
            queryProvider.Create(axQuery, msi);

            var filePath = GetExpectedPath("AxQuery", name, modelName);
            return new { success = true, objectType = "query", objectName = name, modelName, filePath, unsupportedProperties, api = "IMetaQueryProvider.Create" };
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
            var msi = ResolveModelSaveInfo(modelName)
                ?? throw new ArgumentException($"Model '{modelName}' not found in {_packagesPath}");
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
            var msi = ResolveModelSaveInfo(modelName)
                ?? throw new ArgumentException($"Model '{modelName}' not found in {_packagesPath}");
            var axMI = new AxMenuItemAction { Name = name };

            var unsupportedProperties = ApplyMenuItemProperties(axMI, properties);

            var provider = _provider.MenuItemActions as IMetaMenuItemActionProvider
                ?? throw new InvalidOperationException("DiskProvider.MenuItemActions does not implement IMetaMenuItemActionProvider");
            provider.Create(axMI, msi);

            var filePath = GetExpectedPath("AxMenuItemAction", name, modelName);
            return new { success = true, objectType = "menu-item-action", objectName = name, modelName, filePath, unsupportedProperties, api = "IMetaMenuItemActionProvider.Create" };
        }

        /// <summary>
        /// Creates a new MenuItemDisplay object via IMetaMenuItemDisplayProvider.
        /// </summary>
        public object CreateMenuItemDisplay(string name, string modelName, Dictionary<string, string>? properties)
        {
            var msi = ResolveModelSaveInfo(modelName)
                ?? throw new ArgumentException($"Model '{modelName}' not found in {_packagesPath}");
            var axMI = new AxMenuItemDisplay { Name = name };

            var unsupportedProperties = ApplyMenuItemProperties(axMI, properties);

            var provider = _provider.MenuItemDisplays as IMetaMenuItemDisplayProvider
                ?? throw new InvalidOperationException("DiskProvider.MenuItemDisplays does not implement IMetaMenuItemDisplayProvider");
            provider.Create(axMI, msi);

            var filePath = GetExpectedPath("AxMenuItemDisplay", name, modelName);
            return new { success = true, objectType = "menu-item-display", objectName = name, modelName, filePath, unsupportedProperties, api = "IMetaMenuItemDisplayProvider.Create" };
        }

        /// <summary>
        /// Creates a new MenuItemOutput object via IMetaMenuItemOutputProvider.
        /// </summary>
        public object CreateMenuItemOutput(string name, string modelName, Dictionary<string, string>? properties)
        {
            var msi = ResolveModelSaveInfo(modelName)
                ?? throw new ArgumentException($"Model '{modelName}' not found in {_packagesPath}");
            var axMI = new AxMenuItemOutput { Name = name };

            var unsupportedProperties = ApplyMenuItemProperties(axMI, properties);

            var provider = _provider.MenuItemOutputs as IMetaMenuItemOutputProvider
                ?? throw new InvalidOperationException("DiskProvider.MenuItemOutputs does not implement IMetaMenuItemOutputProvider");
            provider.Create(axMI, msi);

            var filePath = GetExpectedPath("AxMenuItemOutput", name, modelName);
            return new { success = true, objectType = "menu-item-output", objectName = name, modelName, filePath, unsupportedProperties, api = "IMetaMenuItemOutputProvider.Create" };
        }

        /// <summary>
        /// Applies a property bag to any of the three menu item types and returns the keys
        /// that did NOT apply. Shared because Action/Display/Output differ only in their
        /// provider — the property surface is AxMenuItem's for all three.
        /// </summary>
        private List<string> ApplyMenuItemProperties(dynamic axMI, Dictionary<string, string>? properties)
        {
            var unsupported = new List<string>();
            if (properties == null) return unsupported;
            foreach (var kv in properties)
                if (!SetAxMenuItemProperty(axMI, kv.Key, kv.Value))
                    unsupported.Add(kv.Key);
            return unsupported;
        }

        /// <summary>
        /// Creates a new SecurityPrivilege object via IMetaSecurityPrivilegeProvider.
        /// </summary>
        public object CreateSecurityPrivilege(string name, string modelName, Dictionary<string, string>? properties)
        {
            var msi = ResolveModelSaveInfo(modelName)
                ?? throw new ArgumentException($"Model '{modelName}' not found in {_packagesPath}");
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
            var msi = ResolveModelSaveInfo(modelName)
                ?? throw new ArgumentException($"Model '{modelName}' not found in {_packagesPath}");
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
            var msi = ResolveModelSaveInfo(modelName)
                ?? throw new ArgumentException($"Model '{modelName}' not found in {_packagesPath}");
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
                    foreach (var ixf in RequireIndexFields(name, ix.Name, ix.Fields))
                        axIdx.AddField(new AxTableIndexField { DataField = ixf });
                    axExt.Indexes.Add(axIdx);
                }
            }

            // Add relations
            if (relations != null)
            {
                foreach (var rel in relations)
                {
                    var axRel = new AxTableRelation { Name = rel.Name, RelatedTable = rel.RelatedTable ?? "" };
                    foreach (var c in RequireRelationConstraints(name, rel.Name, rel.Constraints))
                        axRel.AddConstraint(NewRelationConstraint(rel.Name, c));
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
                    if (!string.IsNullOrEmpty(v.CountryRegionCodes)) axVal.CountryRegionCodes = v.CountryRegionCodes;
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

            var unknownProperties = new List<string>();
            if (properties != null)
            {
                foreach (var kv in properties)
                {
                    switch (kv.Key.ToLowerInvariant())
                    {
                        case "label": axForm.Design.Caption = kv.Value; break;
                        case "caption": axForm.Design.Caption = kv.Value; break;
                        // properties.dataSource used to be accepted and silently dropped, so a
                        // form created with it came out with an empty <DataSources /> and the
                        // caller only found out at compile/runtime. Honour it: the value is the
                        // TABLE name, and the data source takes the same name (D365FO convention).
                        case "datasource":
                        case "table":
                            if (!string.IsNullOrWhiteSpace(kv.Value))
                                axForm.AddDataSource(CreateFormDataSourceRoot(kv.Value.Trim(), kv.Value.Trim(), null));
                            break;
                        default:
                            unknownProperties.Add(kv.Key);
                            break;
                    }
                }
            }

            var hasClassDeclaration = false;
            if (methods != null)
            {
                foreach (var m in methods)
                {
                    if (FormAuthoringDefaults.IsClassDeclarationMethod(m.Name)) hasClassDeclaration = true;
                    axForm.AddMethod(new AxMethod { Name = m.Name, Source = m.Source ?? "" });
                }
            }

            // Without a classDeclaration xppc rejects the form outright
            // ("The 'classDeclaration' is missing from element '<Form>'"), i.e. every
            // bridge-created form was uncompilable. Supply the standard one when absent.
            if (!hasClassDeclaration)
            {
                axForm.AddMethod(new AxMethod
                {
                    Name = FormAuthoringDefaults.ClassDeclarationMethodName,
                    Source = FormAuthoringDefaults.DefaultFormClassDeclaration(name),
                });
            }

            var provider = _provider.Forms as IMetaFormProvider
                ?? throw new InvalidOperationException("DiskProvider.Forms does not implement IMetaFormProvider");
            provider.Create(axForm, msi);

            var filePath = GetExpectedPath("AxForm", name, modelName);
            return new
            {
                success = true,
                objectType = "form",
                objectName = name,
                modelName,
                filePath,
                api = "IMetaFormProvider.Create",
                // Never drop a property silently — an ignored key must be visible to the caller.
                warnings = unknownProperties.Count == 0
                    ? null
                    : new[] { $"Ignored unsupported form properties: {string.Join(", ", unknownProperties)}. Supported: label/caption, dataSource." },
            };
        }

        /// <summary>
        /// Creates a top-level (root) form data source. AxFormDataSource is abstract and a
        /// top-level source MUST be an AxFormDataSourceRoot — picking the first concrete
        /// AxFormDataSourceConcrete subtype can yield AxFormDataSourceReferenced (used for
        /// nested/referenced sources), which AxForm.AddDataSource then fails to cast.
        /// </summary>
        private AxFormDataSourceConcrete CreateFormDataSourceRoot(string dsName, string table, string? joinSource,
            string? linkType = null)
        {
            var assembly = typeof(AxClass).Assembly;
            var dsType = assembly.GetType("Microsoft.Dynamics.AX.Metadata.MetaModel.AxFormDataSourceRoot")
                ?? assembly.GetTypes().FirstOrDefault(t =>
                       typeof(AxFormDataSourceConcrete).IsAssignableFrom(t) && !t.IsAbstract
                       && t.Name == "AxFormDataSourceRoot")
                ?? throw new InvalidOperationException(
                    "AxFormDataSourceRoot type not found in metadata assembly — use xmlContent fallback");
            dynamic ds = Activator.CreateInstance(dsType)!;
            ds.Name = dsName;
            ds.Table = table;
            if (!string.IsNullOrEmpty(joinSource)) ds.JoinSource = joinSource;
            // LinkType used to be accepted by the caller and then dropped here, so a join
            // reported success and serialised without it (findings #35).
            SetEnumProperty((object)ds, "LinkType", linkType);
            return (AxFormDataSourceConcrete)ds;
        }

        /// <summary>
        /// Sets an enum-typed metamodel property from its string name, reflectively.
        ///
        /// The metamodel spells these as generated enums (DataSourceLinkType_ITxt,
        /// Cardinality, RelationshipType …) whose members are the only legal values, so a
        /// typo cannot be written — but it must not be swallowed either. An unparseable
        /// value throws with the full member list rather than leaving the property at its
        /// default, which is exactly how these parameters went missing before: accepted,
        /// dropped, reported as success.
        ///
        /// A null/empty value is a no-op (the caller did not ask for the property).
        /// </summary>
        private static void SetEnumProperty(object target, string propertyName, string? value)
        {
            if (string.IsNullOrWhiteSpace(value)) return;

            var prop = target.GetType().GetProperty(propertyName)
                ?? throw new InvalidOperationException(
                    $"{target.GetType().Name} has no '{propertyName}' property in this metamodel build " +
                    $"({BuildInfo.MetamodelFileVersion}).");
            var enumType = Nullable.GetUnderlyingType(prop.PropertyType) ?? prop.PropertyType;
            if (!enumType.IsEnum)
                throw new InvalidOperationException(
                    $"{target.GetType().Name}.{propertyName} is {enumType.Name}, not an enum.");

            object parsed;
            try
            {
                parsed = Enum.Parse(enumType, value!.Trim(), ignoreCase: true);
            }
            catch (ArgumentException)
            {
                throw new ArgumentException(
                    $"'{value}' is not a valid {propertyName}. Valid values: " +
                    string.Join(", ", Enum.GetNames(enumType)) + ".");
            }
            prop.SetValue(target, parsed);
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
        /// <summary>Finds a form data source by name (case-insensitive); null if absent.</summary>
        private static object? FindFormDataSource(dynamic axForm, string dsName)
        {
            foreach (var ds in axForm.DataSources)
            {
                if (string.Equals((string)((dynamic)ds).Name, dsName, StringComparison.OrdinalIgnoreCase))
                    return (object)ds;
            }
            return null;
        }

        /// <summary>Finds a field on a form data source by name (case-insensitive); null if absent.</summary>
        private static object? FindDsField(dynamic dataSource, string fieldName)
        {
            foreach (var f in dataSource.Fields)
            {
                if (string.Equals((string)((dynamic)f).Name, fieldName, StringComparison.OrdinalIgnoreCase))
                    return (object)f;
            }
            return null;
        }

        public object AddMethod(string objectType, string objectName, string methodName, string source)
        {
            switch (objectType.ToLowerInvariant())
            {
                case "class":
                {
                    var axClass = _provider.Classes.Read(objectName)
                        ?? throw new ArgumentException($"Class '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Classes, objectName);

                    // Update existing method in place to preserve position, or add new
                    if (!TryUpdateMethodSourceInPlace(axClass, methodName, source))
                    {
                        var axMethod = new AxMethod { Name = methodName, Source = source };
                        axClass.AddMethod(axMethod);
                    }

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

                    if (!TryUpdateMethodSourceInPlace(axTable, methodName, source))
                    {
                        var axMethod = new AxMethod { Name = methodName, Source = source };
                        axTable.AddMethod(axMethod);
                    }

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
                    var formProvider = _provider.Forms as IMetaFormProvider
                        ?? throw new InvalidOperationException("IMetaFormProvider not available");

                    // Route a dotted methodName to a data-source (or data-source-field)
                    // override when the first segment is an actual data source on the form:
                    //   "DataSource.method"       → override on the form data source
                    //   "DataSource.Field.method" → override on a data-source field
                    // Without this the method is added as a FORM-CLASS method, where e.g.
                    // a data source initValue()'s super() binds to FormRun.initValue and fails
                    // to compile. Control overrides ("Button.clicked" — first segment is NOT a
                    // data source) fall through to the form-class path below unchanged.
                    var dotParts = methodName.Split('.');
                    if (dotParts.Length is 2 or 3)
                    {
                        dynamic? ds = FindFormDataSource(axForm, dotParts[0]);
                        if (ds != null)
                        {
                            var leaf = dotParts[dotParts.Length - 1];
                            var dsMethod = new AxMethod { Name = leaf, Source = source };
                            if (dotParts.Length == 2)
                            {
                                ds.AddMethod(dsMethod);
                            }
                            else
                            {
                                dynamic field = FindDsField(ds, dotParts[1])
                                    ?? throw new ArgumentException($"Field '{dotParts[1]}' not found on data source '{dotParts[0]}' of form '{objectName}'");
                                field.AddMethod(dsMethod);
                            }
                            formProvider.Update(axForm, msi);
                            return new { success = true, operation = "add-method", objectType, objectName, methodName, api = "IMetaFormProvider.Update (data source override)" };
                        }
                    }

                    if (!TryUpdateMethodSourceInPlace(axForm, methodName, source))
                    {
                        var axMethod = new AxMethod { Name = methodName, Source = source };
                        axForm.AddMethod(axMethod);
                    }

                    formProvider.Update(axForm, msi);

                    return new { success = true, operation = "add-method", objectType, objectName, methodName, api = "IMetaFormProvider.Update" };
                }
                case "query":
                {
                    var axQuery = _provider.Queries.Read(objectName)
                        ?? throw new ArgumentException($"Query '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Queries, objectName);

                    if (!TryUpdateMethodSourceInPlace(axQuery, methodName, source))
                    {
                        var axMethod = new AxMethod { Name = methodName, Source = source };
                        axQuery.AddMethod(axMethod);
                    }

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

                    if (!TryUpdateMethodSourceInPlace(axView, methodName, source))
                    {
                        var axMethod = new AxMethod { Name = methodName, Source = source };
                        axView.AddMethod(axMethod);
                    }

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

                    if (!TryUpdateMethodSourceInPlace(axExt, methodName, source))
                    {
                        var axMethod = new AxMethod { Name = methodName, Source = source };
                        ((dynamic)axExt).Methods.Add(axMethod);
                    }

                    ((IMetaFormExtensionProvider)_provider.FormExtensions).Update(axExt, msi);

                    return new { success = true, operation = "add-method", objectType, objectName, methodName, api = "IMetaFormExtensionProvider.Update" };
                }
                case "class-extension":
                {
                    var axClass = _provider.Classes.Read(objectName)
                        ?? throw new ArgumentException($"Class extension '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Classes, objectName);

                    if (!TryUpdateMethodSourceInPlace(axClass, methodName, source))
                    {
                        var axMethod = new AxMethod { Name = methodName, Source = source };
                        axClass.AddMethod(axMethod);
                    }

                    ((IMetaClassProvider)_provider.Classes).Update(axClass, msi);

                    return new { success = true, operation = "add-method", objectType, objectName, methodName, api = "IMetaClassProvider.Update" };
                }
                case "table-extension":
                {
                    var axExt = _provider.TableExtensions.Read(objectName)
                        ?? throw new ArgumentException($"Table extension '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.TableExtensions, objectName);

                    if (!TryUpdateMethodSourceInPlace(axExt, methodName, source))
                    {
                        var axMethod = new AxMethod { Name = methodName, Source = source };
                        ((dynamic)axExt).Methods.Add(axMethod);
                    }

                    ((IMetaTableExtensionProvider)_provider.TableExtensions).Update(axExt, msi);

                    return new { success = true, operation = "add-method", objectType, objectName, methodName, api = "IMetaTableExtensionProvider.Update" };
                }
                default:
                    throw new ArgumentException($"add-method not supported for objectType '{objectType}' via bridge (use XML fallback)");
            }
        }

        /// <summary>
        /// Adds a field to a table, a table-extension, or a data-entity-view-extension.
        ///
        /// The data-entity case is structurally different and therefore keyed off its own
        /// parameter pair rather than the object name: a mapped field is an
        /// AxDataEntityViewMappedField (Name/DataField/DataSource/Label/Mandatory), which
        /// carries NO EDT and no base type — it only points at a field on one of the
        /// entity's data sources. Confirmed against this VM's metamodel:
        /// AxDataEntityViewExtension.Fields is KeyedObjectCollection&lt;AxDataEntityViewField&gt;,
        /// AxDataEntityViewMappedField derives from AxDataEntityViewField, and
        /// IMetaDataEntityViewExtensionProvider implements
        /// ISingleKeyedMetadataProvider&lt;AxDataEntityViewExtension&gt; directly (no cast needed,
        /// unlike Forms/Tables where Update is an explicit interface member).
        ///
        /// fieldGroupName is optional and appends the new field to a BASE-entity field group
        /// via &lt;FieldGroupExtensions&gt; (AutoReport is what the shipped extensions use). It is
        /// not defaulted: guessing a group that the base entity does not have is a compile
        /// error, and a field is perfectly valid over OData without one.
        /// </summary>
        public object AddField(string tableName, string fieldName, string fieldType,
            string? edt, bool mandatory, string? label,
            string? dataField = null, string? dataSource = null, string? fieldGroupName = null)
        {
            if (!string.IsNullOrEmpty(dataSource) || !string.IsNullOrEmpty(dataField))
            {
                return AddDataEntityMappedField(tableName, fieldName, dataField, dataSource, label, mandatory, fieldGroupName);
            }

            var param = new WriteFieldParam
            {
                Name = fieldName,
                FieldType = fieldType,
                Edt = edt,
                Mandatory = mandatory,
                Label = label
            };
            var axField = CreateTableField(param);

            var axTable = _provider.Tables.Read(tableName);
            if (axTable != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.Tables, tableName);
                axTable.AddField(axField);
                var tableProvider = _provider.Tables as IMetaTableProvider
                    ?? throw new InvalidOperationException("IMetaTableProvider not available");
                tableProvider.Update(axTable, msi);
                return new { success = true, operation = "add-field", objectName = tableName, fieldName, fieldType, api = "IMetaTableProvider.Update" };
            }

            var axExt = _provider.TableExtensions.Read(tableName);
            if (axExt != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.TableExtensions, tableName);
                axExt.Fields.Add(axField);
                var extProvider = _provider.TableExtensions as IMetaTableExtensionProvider
                    ?? throw new InvalidOperationException("IMetaTableExtensionProvider not available");
                extProvider.Update(axExt, msi);
                return new { success = true, operation = "add-field", objectName = tableName, fieldName, fieldType, api = "IMetaTableExtensionProvider.Update" };
            }

            throw new ArgumentException($"Table or table-extension '{tableName}' not found");
        }

        /// <summary>
        /// add-field on a data-entity-view-extension: appends an AxDataEntityViewMappedField
        /// to &lt;Fields&gt;, optionally registering it in a base-entity field group.
        /// </summary>
        private object AddDataEntityMappedField(string extensionName, string fieldName,
            string? dataField, string? dataSource, string? label, bool mandatory, string? fieldGroupName)
        {
            // Both halves of the binding are required. A mapped field with only one of them
            // serialises fine and then fails to compile — the worst of both outcomes, which is
            // why this is rejected here rather than written half-bound.
            if (string.IsNullOrEmpty(dataSource))
                throw new ArgumentException("add-field on a data-entity-extension requires dataSource (the entity data-source the field reads from) alongside dataField.");
            if (string.IsNullOrEmpty(dataField))
                throw new ArgumentException("add-field on a data-entity-extension requires dataField (the source table field) alongside dataSource.");

            var axExt = _provider.DataEntityViewExtensions.Read(extensionName)
                ?? throw new ArgumentException($"Data entity view extension '{extensionName}' not found");
            var msi = GetModelSaveInfoForObject(_provider.DataEntityViewExtensions, extensionName);

            foreach (AxDataEntityViewField existing in axExt.Fields)
            {
                if (string.Equals(existing.Name, fieldName, StringComparison.OrdinalIgnoreCase))
                    return new { success = true, operation = "add-field", objectName = extensionName, fieldName, skipped = true, reason = $"field '{fieldName}' already exists", api = "IMetaDataEntityViewExtensionProvider.Update" };
            }

            var mapped = new AxDataEntityViewMappedField
            {
                Name = fieldName,
                DataField = dataField,
                DataSource = dataSource
            };
            if (!string.IsNullOrEmpty(label)) mapped.Label = label;
            if (mandatory) mapped.Mandatory = Microsoft.Dynamics.AX.Metadata.Core.MetaModel.AutoNoYes.Yes;
            axExt.Fields.Add(mapped);

            var groupAdded = false;
            if (!string.IsNullOrEmpty(fieldGroupName))
            {
                var group = axExt.FieldGroupExtensions
                    .FirstOrDefault(g => string.Equals(g.Name, fieldGroupName, StringComparison.OrdinalIgnoreCase));
                if (group == null)
                {
                    group = new AxTableFieldGroupExtension { Name = fieldGroupName };
                    axExt.FieldGroupExtensions.Add(group);
                }
                if (!group.Fields.Any(f => string.Equals(f.DataField, fieldName, StringComparison.OrdinalIgnoreCase)))
                {
                    group.Fields.Add(new AxTableFieldGroupField { DataField = fieldName });
                    groupAdded = true;
                }
            }

            _provider.DataEntityViewExtensions.Update(axExt, msi);
            return new
            {
                success = true,
                operation = "add-field",
                objectType = "data-entity-extension",
                objectName = extensionName,
                fieldName,
                dataField,
                dataSource,
                fieldGroupName = groupAdded ? fieldGroupName : null,
                api = "IMetaDataEntityViewExtensionProvider.Update"
            };
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
                    if (!SetAxClassProperty(obj, propertyPath, propertyValue))
                        throw new ArgumentException($"Unknown AxClass property '{propertyPath}' — nothing was written. Supported: extends, isAbstract, isFinal.");
                    ((IMetaClassProvider)_provider.Classes).Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, api = "Update" };
                }
                case "table":
                {
                    var obj = _provider.Tables.Read(objectName)
                        ?? throw new ArgumentException($"Table '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Tables, objectName);
                    if (!SetAxTableProperty(obj, propertyPath, propertyValue))
                        throw new ArgumentException($"Unknown AxTable property '{propertyPath}' — nothing was written. Supported: label, developerDocumentation, configurationKey, formRef, tableGroup, cacheLookup, clusteredIndex, primaryIndex, replacementKey, saveDataPerCompany, allowRowVersionChangeTracking, createdBy, createdDateTime, createdTransactionId, modifiedBy, modifiedDateTime, modifiedTransactionId, tableType, supportInheritance, instanceRelationType, extends, titleField1, titleField2.");
                    ((IMetaTableProvider)_provider.Tables).Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, api = "Update" };
                }
                case "enum":
                {
                    var obj = _provider.Enums.Read(objectName)
                        ?? throw new ArgumentException($"Enum '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Enums, objectName);
                    if (!SetAxEnumProperty(obj, propertyPath, propertyValue))
                        throw new ArgumentException($"Unknown AxEnum property '{propertyPath}' — nothing was written. Supported: label, isExtensible, useEnumValue.");
                    ((IMetaEnumProvider)_provider.Enums).Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, api = "Update" };
                }
                case "edt":
                {
                    var obj = _provider.Edts.Read(objectName)
                        ?? throw new ArgumentException($"EDT '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Edts, objectName);
                    if (!SetAxEdtProperty(obj, propertyPath, propertyValue))
                        throw new ArgumentException($"Unknown AxEdt property '{propertyPath}' — nothing was written. Supported: label, helpText, extends, stringSize, referenceTable.");
                    ((IMetaEdtProvider)_provider.Edts).Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, api = "Update" };
                }
                case "query":
                {
                    var obj = _provider.Queries.Read(objectName)
                        ?? throw new ArgumentException($"Query '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Queries, objectName);
                    if (!SetAxQueryProperty(obj, propertyPath, propertyValue))
                        throw new ArgumentException($"Unknown (or unavailable on this subclass) AxQuery property '{propertyPath}' — nothing was written. Supported: title, description, allowCrossCompany.");
                    ((IMetaQueryProvider)_provider.Queries).Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, api = "Update" };
                }
                case "view":
                {
                    var obj = _provider.Views.Read(objectName)
                        ?? throw new ArgumentException($"View '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Views, objectName);
                    if (!SetAxViewProperty(obj, propertyPath, propertyValue))
                        throw new ArgumentException($"Unknown AxView property '{propertyPath}' — nothing was written. Supported: label, developerDocumentation.");
                    ((IMetaViewProvider)_provider.Views).Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, api = "Update" };
                }
                case "data-entity":
                {
                    var obj = _provider.DataEntityViews.Read(objectName)
                        ?? throw new ArgumentException($"Data entity '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.DataEntityViews, objectName);
                    if (!SetAxDataEntityViewProperty(obj, propertyPath, propertyValue))
                        throw new ArgumentException($"Unknown AxDataEntityView property '{propertyPath}' — nothing was written. Supported: label, developerDocumentation, primaryKey, isPublic, publicEntityName, publicCollectionName, dataManagementEnabled, dataManagementStagingTable, entityCategory, allowRowVersionChangeTracking, allowRetention.");
                    ((IMetaDataEntityViewProvider)_provider.DataEntityViews).Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, api = "Update" };
                }
                case "menu-item-action":
                {
                    var obj = _provider.MenuItemActions.Read(objectName)
                        ?? throw new ArgumentException($"MenuItemAction '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.MenuItemActions, objectName);
                    if (!SetAxMenuItemProperty(obj, propertyPath, propertyValue))
                        throw new ArgumentException($"Unknown (or unsupported) AxMenuItem property '{propertyPath}' — nothing was written. Supported: label, helpText, object, objectType, openMode, normalImage, configurationKey, countryRegionCodes, maintainUserAuthorization.");
                    ((IMetaMenuItemActionProvider)_provider.MenuItemActions).Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, api = "Update" };
                }
                case "menu-item-display":
                {
                    var obj = _provider.MenuItemDisplays.Read(objectName)
                        ?? throw new ArgumentException($"MenuItemDisplay '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.MenuItemDisplays, objectName);
                    if (!SetAxMenuItemProperty(obj, propertyPath, propertyValue))
                        throw new ArgumentException($"Unknown (or unsupported) AxMenuItem property '{propertyPath}' — nothing was written. Supported: label, helpText, object, objectType, openMode, normalImage, configurationKey, countryRegionCodes, maintainUserAuthorization.");
                    ((IMetaMenuItemDisplayProvider)_provider.MenuItemDisplays).Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, api = "Update" };
                }
                case "menu-item-output":
                {
                    var obj = _provider.MenuItemOutputs.Read(objectName)
                        ?? throw new ArgumentException($"MenuItemOutput '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.MenuItemOutputs, objectName);
                    if (!SetAxMenuItemProperty(obj, propertyPath, propertyValue))
                        throw new ArgumentException($"Unknown (or unsupported) AxMenuItem property '{propertyPath}' — nothing was written. Supported: label, helpText, object, objectType, openMode, normalImage, configurationKey, countryRegionCodes, maintainUserAuthorization.");
                    ((IMetaMenuItemOutputProvider)_provider.MenuItemOutputs).Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, api = "Update" };
                }
                // ── Extensions ───────────────────────────────────────────────────────
                // An extension never sets a property directly: it records an override as an
                // <AxPropertyModification> Name/Value pair, which the AOS applies over the base
                // object at load. So there is no per-property whitelist here — the metamodel of
                // the BASE object decides what is legal, and an unknown name is caught by the
                // compiler, not by us guessing which names exist.
                case "table-extension":
                {
                    var obj = _provider.TableExtensions.Read(objectName)
                        ?? throw new ArgumentException($"Table extension '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.TableExtensions, objectName);
                    var extProvider = _provider.TableExtensions as IMetaTableExtensionProvider
                        ?? throw new InvalidOperationException("IMetaTableExtensionProvider not available");

                    // "Relations/<RelationName>/<Property>" targets a BASE-table relation and
                    // lands in <RelationModifications> instead. add-relation cannot express this
                    // (its properties belong to a relation the extension owns), which is why
                    // BPErrorTableRelationshipPropertiesCompleteness on an extended relation had
                    // no repair path at all (findings #5 / #35).
                    var relationTarget = ParseRelationPropertyPath(propertyPath);
                    if (relationTarget != null)
                    {
                        var (relName, relProp) = relationTarget.Value;
                        var relMod = GetOrAddExtensionModification(obj.RelationModifications, relName);
                        UpsertPropertyModification(relMod.PropertyModifications, relProp, propertyValue);
                        extProvider.Update(obj, msi);
                        return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, target = "RelationModifications", relationName = relName, api = "IMetaTableExtensionProvider.Update" };
                    }

                    UpsertPropertyModification(obj.PropertyModifications, propertyPath, propertyValue);
                    extProvider.Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, target = "PropertyModifications", api = "IMetaTableExtensionProvider.Update" };
                }
                case "form-extension":
                {
                    var obj = _provider.FormExtensions.Read(objectName)
                        ?? throw new ArgumentException($"Form extension '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.FormExtensions, objectName);
                    UpsertPropertyModification(obj.PropertyModifications, propertyPath, propertyValue);
                    ((IMetaFormExtensionProvider)_provider.FormExtensions).Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, target = "PropertyModifications", api = "IMetaFormExtensionProvider.Update" };
                }
                case "enum-extension":
                {
                    var obj = _provider.EnumExtensions.Read(objectName)
                        ?? throw new ArgumentException($"Enum extension '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.EnumExtensions, objectName);
                    UpsertPropertyModification(obj.PropertyModifications, propertyPath, propertyValue);
                    var extProvider = _provider.EnumExtensions as IMetaEnumExtensionProvider
                        ?? throw new InvalidOperationException("IMetaEnumExtensionProvider not available");
                    extProvider.Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, target = "PropertyModifications", api = "IMetaEnumExtensionProvider.Update" };
                }
                case "edt-extension":
                {
                    var obj = _provider.EdtExtensions.Read(objectName)
                        ?? throw new ArgumentException($"EDT extension '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.EdtExtensions, objectName);
                    UpsertPropertyModification(obj.PropertyModifications, propertyPath, propertyValue);
                    var extProvider = _provider.EdtExtensions as IMetaEdtExtensionProvider
                        ?? throw new InvalidOperationException("IMetaEdtExtensionProvider not available");
                    extProvider.Update(obj, msi);
                    return new { success = true, operation = "modify-property", objectType, objectName, propertyPath, propertyValue, target = "PropertyModifications", api = "IMetaEdtExtensionProvider.Update" };
                }
                default:
                    throw new ArgumentException($"modify-property not supported for objectType '{objectType}' via bridge");
            }
        }

        /// <summary>
        /// Recognises "Relations/&lt;RelationName&gt;/&lt;Property&gt;" (or the dotted spelling)
        /// and splits it. Anything else returns null and is treated as a plain object-level
        /// property, so an ordinary path can never be mistaken for a relation override.
        /// </summary>
        private static (string RelationName, string Property)? ParseRelationPropertyPath(string propertyPath)
        {
            var parts = propertyPath.Split(new[] { '/', '.' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length != 3) return null;
            if (!string.Equals(parts[0], "Relations", StringComparison.OrdinalIgnoreCase)) return null;
            return (parts[1], parts[2]);
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

        /// <summary>
        /// The field list of an index, refused when it holds nothing usable.
        ///
        /// A null/empty `fields` serialized as &lt;Fields /&gt; and the call returned
        /// success: the index compiles, raises no BP warning, and indexes nothing — the
        /// silent-empty-write failure mode, where the object is only discovered to be
        /// inert long after the caller was told it was written. The usual cause is a
        /// param-shape mismatch (fields sent as [{fieldName}] instead of a flat string[]),
        /// so failing here is also what makes that visible.
        /// </summary>
        private static List<string> RequireIndexFields(string tableName, string indexName, List<string>? fields)
        {
            if (fields == null || fields.Count == 0)
                throw new ArgumentException(
                    $"Index '{indexName}' on '{tableName}' has no fields — pass the field names as a string array in 'fields'. " +
                    "An index with an empty <Fields /> collection compiles clean and indexes nothing.");

            for (var i = 0; i < fields.Count; i++)
            {
                if (string.IsNullOrWhiteSpace(fields[i]))
                    throw new ArgumentException(
                        $"Index '{indexName}' on '{tableName}': fields[{i}] is empty. " +
                        "Every entry must name a field on the table.");
            }
            return fields;
        }

        /// <summary>Adds an index to a table or table-extension.</summary>
        public object AddIndex(string tableName, string indexName, List<string>? fields, bool allowDuplicates, bool alternateKey)
        {
            var indexFields = RequireIndexFields(tableName, indexName, fields);

            var axIdx = new AxTableIndex { Name = indexName };
            axIdx.AllowDuplicates = allowDuplicates ? Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.Yes : Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.No;
            if (alternateKey)
                axIdx.AlternateKey = Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.Yes;
            foreach (var f in indexFields)
                axIdx.AddField(new AxTableIndexField { DataField = f });

            var axTable = _provider.Tables.Read(tableName);
            if (axTable != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.Tables, tableName);
                axTable.AddIndex(axIdx);
                ((IMetaTableProvider)_provider.Tables).Update(axTable, msi);
                return new { success = true, operation = "add-index", objectName = tableName, indexName, fieldCount = indexFields.Count, api = "IMetaTableProvider.Update" };
            }

            var axExt = _provider.TableExtensions.Read(tableName);
            if (axExt != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.TableExtensions, tableName);
                axExt.Indexes.Add(axIdx);
                var extProvider = _provider.TableExtensions as IMetaTableExtensionProvider
                    ?? throw new InvalidOperationException("IMetaTableExtensionProvider not available");
                extProvider.Update(axExt, msi);
                return new { success = true, operation = "add-index", objectName = tableName, indexName, fieldCount = indexFields.Count, api = "IMetaTableExtensionProvider.Update" };
            }

            throw new ArgumentException($"Table or table-extension '{tableName}' not found");
        }

        /// <summary>Removes an index from a table or table-extension.</summary>
        public object RemoveIndex(string tableName, string indexName)
        {
            var axTable = _provider.Tables.Read(tableName);
            if (axTable != null)
            {
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

            var axExt = _provider.TableExtensions.Read(tableName);
            if (axExt != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.TableExtensions, tableName);
                AxTableIndex? toRemove = null;
                foreach (AxTableIndex idx in axExt.Indexes)
                {
                    if (string.Equals(idx.Name, indexName, StringComparison.OrdinalIgnoreCase))
                    { toRemove = idx; break; }
                }
                if (toRemove == null)
                    throw new InvalidOperationException($"Index '{indexName}' not found on table-extension '{tableName}'");
                axExt.Indexes.Remove(toRemove);
                var extProvider = _provider.TableExtensions as IMetaTableExtensionProvider
                    ?? throw new InvalidOperationException("IMetaTableExtensionProvider not available");
                extProvider.Update(axExt, msi);
                return new { success = true, operation = "remove-index", objectName = tableName, indexName, api = "IMetaTableExtensionProvider.Update" };
            }

            throw new ArgumentException($"Table or table-extension '{tableName}' not found");
        }

        // ========================
        // TABLE FULL-TEXT INDEX OPERATIONS
        // ========================

        /// <summary>
        /// Adds a full-text index to a table or table-extension.
        ///
        /// A separate collection from &lt;Indexes&gt; with a separate element type
        /// (AxTableFullTextIndex), so add-index could never reach it. ChangeTracking is left at
        /// the metamodel default rather than guessed — it drives how the AOS maintains the
        /// index and is not something to pick on the caller's behalf.
        /// </summary>
        public object AddFullTextIndex(string tableName, string indexName, List<string>? fields)
        {
            var indexFields = RequireIndexFields(tableName, indexName, fields);

            var axIdx = new AxTableFullTextIndex { Name = indexName };
            foreach (var f in indexFields)
                axIdx.Fields.Add(new AxTableIndexField { DataField = f });

            var axTable = _provider.Tables.Read(tableName);
            if (axTable != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.Tables, tableName);
                axTable.FullTextIndexes.Add(axIdx);
                ((IMetaTableProvider)_provider.Tables).Update(axTable, msi);
                return new { success = true, operation = "add-full-text-index", objectName = tableName, indexName, fieldCount = indexFields.Count, api = "IMetaTableProvider.Update" };
            }

            var axExt = _provider.TableExtensions.Read(tableName);
            if (axExt != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.TableExtensions, tableName);
                axExt.FullTextIndexes.Add(axIdx);
                var extProvider = _provider.TableExtensions as IMetaTableExtensionProvider
                    ?? throw new InvalidOperationException("IMetaTableExtensionProvider not available");
                extProvider.Update(axExt, msi);
                return new { success = true, operation = "add-full-text-index", objectName = tableName, indexName, fieldCount = indexFields.Count, api = "IMetaTableExtensionProvider.Update" };
            }

            throw new ArgumentException($"Table or table-extension '{tableName}' not found");
        }

        /// <summary>Removes a full-text index from a table or table-extension.</summary>
        public object RemoveFullTextIndex(string tableName, string indexName)
        {
            var axTable = _provider.Tables.Read(tableName);
            if (axTable != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.Tables, tableName);
                var toRemove = FindFullTextIndex(axTable.FullTextIndexes, indexName)
                    ?? throw new InvalidOperationException($"Full-text index '{indexName}' not found on table '{tableName}'");
                axTable.FullTextIndexes.Remove(toRemove);
                ((IMetaTableProvider)_provider.Tables).Update(axTable, msi);
                return new { success = true, operation = "remove-full-text-index", objectName = tableName, indexName, api = "IMetaTableProvider.Update" };
            }

            var axExt = _provider.TableExtensions.Read(tableName);
            if (axExt != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.TableExtensions, tableName);
                var toRemove = FindFullTextIndex(axExt.FullTextIndexes, indexName)
                    ?? throw new InvalidOperationException($"Full-text index '{indexName}' not found on table-extension '{tableName}'");
                axExt.FullTextIndexes.Remove(toRemove);
                var extProvider = _provider.TableExtensions as IMetaTableExtensionProvider
                    ?? throw new InvalidOperationException("IMetaTableExtensionProvider not available");
                extProvider.Update(axExt, msi);
                return new { success = true, operation = "remove-full-text-index", objectName = tableName, indexName, api = "IMetaTableExtensionProvider.Update" };
            }

            throw new ArgumentException($"Table or table-extension '{tableName}' not found");
        }

        private static AxTableFullTextIndex? FindFullTextIndex(IEnumerable<AxTableFullTextIndex> indexes, string indexName)
        {
            foreach (AxTableFullTextIndex idx in indexes)
            {
                if (string.Equals(idx.Name, indexName, StringComparison.OrdinalIgnoreCase))
                    return idx;
            }
            return null;
        }

        // ========================
        // TABLE MAPPING OPERATIONS
        // ========================

        /// <summary>
        /// Adds a Map membership to a table or table-extension: which AxMap the table takes
        /// part in, and how its fields line up with the map's.
        ///
        /// AxTableMapping.Name is the MAP's name and MappingTable is the mapped table; each
        /// connection is MapField (the field on the map) → MapFieldTo (the field on this
        /// table). Both are required per connection — a half-filled connection serialises and
        /// then fails to compile.
        /// </summary>
        public object AddTableMapping(string tableName, string mapName, string? mappingTable,
            List<WriteMappingConnection>? connections)
        {
            var axMapping = new AxTableMapping { Name = mapName, MappingTable = mappingTable ?? mapName };
            if (connections != null)
            {
                foreach (var c in connections)
                {
                    if (string.IsNullOrEmpty(c.MapField) || string.IsNullOrEmpty(c.MapFieldTo))
                        throw new ArgumentException(
                            $"Mapping connection on '{mapName}' needs both mapField and mapFieldTo — got mapField='{c.MapField}', mapFieldTo='{c.MapFieldTo}'.");
                    axMapping.Connections.Add(new AxTableMappingConnection
                    {
                        MapField = c.MapField,
                        MapFieldTo = c.MapFieldTo,
                    });
                }
            }

            var axTable = _provider.Tables.Read(tableName);
            if (axTable != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.Tables, tableName);
                axTable.Mappings.Add(axMapping);
                ((IMetaTableProvider)_provider.Tables).Update(axTable, msi);
                return new { success = true, operation = "add-table-mapping", objectName = tableName, mapName, connectionCount = connections?.Count ?? 0, api = "IMetaTableProvider.Update" };
            }

            var axExt = _provider.TableExtensions.Read(tableName);
            if (axExt != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.TableExtensions, tableName);
                axExt.Mappings.Add(axMapping);
                var extProvider = _provider.TableExtensions as IMetaTableExtensionProvider
                    ?? throw new InvalidOperationException("IMetaTableExtensionProvider not available");
                extProvider.Update(axExt, msi);
                return new { success = true, operation = "add-table-mapping", objectName = tableName, mapName, connectionCount = connections?.Count ?? 0, api = "IMetaTableExtensionProvider.Update" };
            }

            throw new ArgumentException($"Table or table-extension '{tableName}' not found");
        }

        /// <summary>Removes a Map membership from a table or table-extension.</summary>
        public object RemoveTableMapping(string tableName, string mapName)
        {
            var axTable = _provider.Tables.Read(tableName);
            if (axTable != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.Tables, tableName);
                var toRemove = FindMapping(axTable.Mappings, mapName)
                    ?? throw new InvalidOperationException($"Mapping '{mapName}' not found on table '{tableName}'");
                axTable.Mappings.Remove(toRemove);
                ((IMetaTableProvider)_provider.Tables).Update(axTable, msi);
                return new { success = true, operation = "remove-table-mapping", objectName = tableName, mapName, api = "IMetaTableProvider.Update" };
            }

            var axExt = _provider.TableExtensions.Read(tableName);
            if (axExt != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.TableExtensions, tableName);
                var toRemove = FindMapping(axExt.Mappings, mapName)
                    ?? throw new InvalidOperationException($"Mapping '{mapName}' not found on table-extension '{tableName}'");
                axExt.Mappings.Remove(toRemove);
                var extProvider = _provider.TableExtensions as IMetaTableExtensionProvider
                    ?? throw new InvalidOperationException("IMetaTableExtensionProvider not available");
                extProvider.Update(axExt, msi);
                return new { success = true, operation = "remove-table-mapping", objectName = tableName, mapName, api = "IMetaTableExtensionProvider.Update" };
            }

            throw new ArgumentException($"Table or table-extension '{tableName}' not found");
        }

        private static AxTableMapping? FindMapping(IEnumerable<AxTableMapping> mappings, string mapName)
        {
            foreach (AxTableMapping m in mappings)
            {
                if (string.Equals(m.Name, mapName, StringComparison.OrdinalIgnoreCase))
                    return m;
            }
            return null;
        }

        // ========================
        // TABLE RELATION OPERATIONS
        // ========================

        /// <summary>
        /// One relation constraint, refused when either side is blank.
        ///
        /// `Field = c.Field ?? ""` wrote a nameless &lt;AxTableRelationConstraintField&gt;:
        /// the relation was reported as added, joined nothing, and the damage surfaced
        /// only at compile time. Blank on BOTH sides is the signature of the param-shape
        /// mismatch the TS side remaps around — constraints arriving as
        /// {fieldName, relatedFieldName} deserialize into a WriteRelationConstraint whose
        /// two properties are null. Name it instead of writing it.
        /// </summary>
        private static AxTableRelationConstraintField NewRelationConstraint(string relationName, WriteRelationConstraint c)
        {
            var field = c.Field?.Trim();
            var relatedField = c.RelatedField?.Trim();
            if (string.IsNullOrEmpty(field) || string.IsNullOrEmpty(relatedField))
                throw new ArgumentException(
                    $"Relation '{relationName}' has a constraint with an empty field name " +
                    $"(field='{c.Field}', relatedField='{c.RelatedField}'). Every constraint needs both keys: " +
                    "{\"field\": \"<field on this table>\", \"relatedField\": \"<field on the related table>\"}.");

            return new AxTableRelationConstraintField { Name = field, Field = field, RelatedField = relatedField };
        }

        /// <summary>
        /// The constraint list of a relation, refused when empty — a relation with no
        /// constraint fields joins nothing, so writing one is the same silent-empty-write
        /// as an index with no fields.
        /// </summary>
        private static List<WriteRelationConstraint> RequireRelationConstraints(
            string tableName, string relationName, List<WriteRelationConstraint>? constraints)
        {
            if (constraints == null || constraints.Count == 0)
                throw new ArgumentException(
                    $"Relation '{relationName}' on '{tableName}' has no constraints — pass 'constraints' as " +
                    "[{\"field\": \"<field on this table>\", \"relatedField\": \"<field on the related table>\"}]. " +
                    "A relation with an empty <Constraints /> collection joins nothing.");
            return constraints;
        }

        /// <summary>
        /// Adds a relation to a table.
        ///
        /// Cardinality / RelatedTableCardinality / RelationshipType are real
        /// AxTableRelation properties (verified against this VM's metamodel), but this
        /// method used to set only Name, RelatedTable and the constraints — so a relation
        /// reported "✅ added" and then failed BP with
        /// BPErrorTableRelationshipPropertiesCompleteness naming exactly those three
        /// (findings #5 / #35). The TS side patched them onto the XML afterwards as a
        /// workaround; writing them through the provider is what puts them in the
        /// serialiser's own element order instead of a hand-anchored one.
        /// </summary>
        public object AddRelation(string tableName, string relationName, string relatedTable,
            List<WriteRelationConstraint>? constraints,
            string? cardinality = null, string? relatedTableCardinality = null, string? relationshipType = null)
        {
            var relationConstraints = RequireRelationConstraints(tableName, relationName, constraints);

            var axRel = new AxTableRelation { Name = relationName, RelatedTable = relatedTable };
            SetEnumProperty(axRel, "Cardinality", cardinality);
            SetEnumProperty(axRel, "RelatedTableCardinality", relatedTableCardinality);
            SetEnumProperty(axRel, "RelationshipType", relationshipType);
            foreach (var c in relationConstraints)
                axRel.AddConstraint(NewRelationConstraint(relationName, c));

            var axTable = _provider.Tables.Read(tableName);
            if (axTable != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.Tables, tableName);
                axTable.AddRelation(axRel);
                ((IMetaTableProvider)_provider.Tables).Update(axTable, msi);
                return new
                {
                    success = true, operation = "add-relation", objectName = tableName, relationName, relatedTable,
                    cardinality = axRel.Cardinality.ToString(),
                    relatedTableCardinality = axRel.RelatedTableCardinality.ToString(),
                    relationshipType = axRel.RelationshipType.ToString(),
                    api = "IMetaTableProvider.Update",
                };
            }

            var axExt = _provider.TableExtensions.Read(tableName);
            if (axExt != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.TableExtensions, tableName);
                var extProvider = _provider.TableExtensions as IMetaTableExtensionProvider
                    ?? throw new InvalidOperationException("IMetaTableExtensionProvider not available");

                // An extension has TWO relation collections and the caller's intent decides
                // which one is correct:
                //   <Relations>          — a brand-new relation the extension itself defines.
                //   <RelationExtensions> — extra constraints bolted onto a relation the BASE
                //                          table already owns.
                // Writing a new <AxTableRelation> under a name the base table already uses is
                // not "also fine": it is a second, competing relation of the same name. So when
                // the name resolves on the base table, route to RelationExtensions instead —
                // extending a shipped relation is the far more common ask, and it had no path
                // at all before (#803).
                if (BaseTableOwnsRelation(tableName, relationName))
                {
                    AxTableRelationExtension? relExt = null;
                    foreach (AxTableRelationExtension re in axExt.RelationExtensions)
                    {
                        if (string.Equals(re.Name, relationName, StringComparison.OrdinalIgnoreCase))
                        { relExt = re; break; }
                    }
                    if (relExt == null)
                    {
                        // KeyedObjectCollection — a duplicate key fails inside the SDK, so only
                        // create the entry when this extension does not already carry one.
                        relExt = new AxTableRelationExtension { Name = relationName };
                        axExt.RelationExtensions.Add(relExt);
                    }

                    var added = new List<string>();
                    foreach (var c in relationConstraints)
                    {
                        var constraint = NewRelationConstraint(relationName, c);
                        var already = false;
                        foreach (AxTableRelationConstraint existing in relExt.RelationConstraints)
                        {
                            if (string.Equals(existing.Name, constraint.Name, StringComparison.OrdinalIgnoreCase))
                            { already = true; break; }
                        }
                        if (already) continue;
                        relExt.RelationConstraints.Add(constraint);
                        added.Add(constraint.Name);
                    }

                    extProvider.Update(axExt, msi);
                    // Cardinality / RelatedTableCardinality / RelationshipType are properties of
                    // the BASE relation and an AxTableRelationExtension has nowhere to put them.
                    // They are reported as skipped rather than echoed back, so neither the caller
                    // nor the TS-side property patch can mistake them for written.
                    return new
                    {
                        success = true, operation = "add-relation", objectName = tableName, relationName, relatedTable,
                        target = "RelationExtensions",
                        constraintsAdded = added,
                        note = $"'{relationName}' is owned by the base table — the constraints were appended through <RelationExtensions>. " +
                               "Cardinality / RelatedTableCardinality / RelationshipType belong to the base relation and were NOT written; change them on the base table if they are wrong.",
                        api = "IMetaTableExtensionProvider.Update",
                    };
                }

                axExt.Relations.Add(axRel);
                extProvider.Update(axExt, msi);
                return new
                {
                    success = true, operation = "add-relation", objectName = tableName, relationName, relatedTable,
                    target = "Relations",
                    cardinality = axRel.Cardinality.ToString(),
                    relatedTableCardinality = axRel.RelatedTableCardinality.ToString(),
                    relationshipType = axRel.RelationshipType.ToString(),
                    api = "IMetaTableExtensionProvider.Update",
                };
            }

            throw new ArgumentException($"Table or table-extension '{tableName}' not found");
        }

        /// <summary>
        /// Does the table a given extension extends already own a relation of this name?
        ///
        /// The base table is the extension name up to the first dot ("CustTable.FooExtension"
        /// → "CustTable"); an extension name always has one, a table name never can. A base
        /// table that cannot be read (outside the provider's roots) is reported as NOT owning
        /// the relation, so the caller falls back to the previous behaviour rather than
        /// silently doing nothing.
        /// </summary>
        private bool BaseTableOwnsRelation(string extensionName, string relationName)
        {
            var dot = extensionName.IndexOf('.');
            if (dot <= 0) return false;
            var baseTable = _provider.Tables.Read(extensionName.Substring(0, dot));
            if (baseTable == null) return false;
            foreach (AxTableRelation rel in baseTable.Relations)
            {
                if (string.Equals(rel.Name, relationName, StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            return false;
        }

        /// <summary>Removes a relation from a table or table-extension.</summary>
        public object RemoveRelation(string tableName, string relationName)
        {
            var axTable = _provider.Tables.Read(tableName);
            if (axTable != null)
            {
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

            var axExt = _provider.TableExtensions.Read(tableName);
            if (axExt != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.TableExtensions, tableName);
                AxTableRelation? toRemove = null;
                foreach (AxTableRelation rel in axExt.Relations)
                {
                    if (string.Equals(rel.Name, relationName, StringComparison.OrdinalIgnoreCase))
                    { toRemove = rel; break; }
                }
                if (toRemove == null)
                    throw new InvalidOperationException($"Relation '{relationName}' not found on table-extension '{tableName}'");
                axExt.Relations.Remove(toRemove);
                var extProvider = _provider.TableExtensions as IMetaTableExtensionProvider
                    ?? throw new InvalidOperationException("IMetaTableExtensionProvider not available");
                extProvider.Update(axExt, msi);
                return new { success = true, operation = "remove-relation", objectName = tableName, relationName, api = "IMetaTableExtensionProvider.Update" };
            }

            throw new ArgumentException($"Table or table-extension '{tableName}' not found");
        }

        // ========================
        // TABLE FIELD GROUP OPERATIONS
        // ========================

        /// <summary>Adds a field group to a table or table-extension.</summary>
        public object AddFieldGroup(string tableName, string groupName, string? label, List<string>? fields)
        {
            var axFg = new AxTableFieldGroup { Name = groupName };
            if (!string.IsNullOrEmpty(label)) axFg.Label = label;
            if (fields != null)
            {
                foreach (var fieldRef in fields)
                    axFg.AddField(new AxTableFieldGroupField { DataField = fieldRef });
            }

            var axTable = _provider.Tables.Read(tableName);
            if (axTable != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.Tables, tableName);
                axTable.AddFieldGroup(axFg);
                ((IMetaTableProvider)_provider.Tables).Update(axTable, msi);
                return new { success = true, operation = "add-field-group", objectName = tableName, groupName, fieldCount = fields?.Count ?? 0, api = "IMetaTableProvider.Update" };
            }

            var axExt = _provider.TableExtensions.Read(tableName);
            if (axExt != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.TableExtensions, tableName);
                axExt.FieldGroups.Add(axFg);
                var extProvider = _provider.TableExtensions as IMetaTableExtensionProvider
                    ?? throw new InvalidOperationException("IMetaTableExtensionProvider not available");
                extProvider.Update(axExt, msi);
                return new { success = true, operation = "add-field-group", objectName = tableName, groupName, fieldCount = fields?.Count ?? 0, api = "IMetaTableExtensionProvider.Update" };
            }

            throw new ArgumentException($"Table or table-extension '{tableName}' not found");
        }

        /// <summary>Removes a field group from a table or table-extension.</summary>
        public object RemoveFieldGroup(string tableName, string groupName)
        {
            var axTable = _provider.Tables.Read(tableName);
            if (axTable != null)
            {
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

            var axExt = _provider.TableExtensions.Read(tableName);
            if (axExt != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.TableExtensions, tableName);
                AxTableFieldGroup? toRemove = null;
                foreach (AxTableFieldGroup fg in axExt.FieldGroups)
                {
                    if (string.Equals(fg.Name, groupName, StringComparison.OrdinalIgnoreCase))
                    { toRemove = fg; break; }
                }
                // A group the extension does not OWN may still be extended by it — say so
                // rather than reporting a bare "not found" the caller cannot act on.
                if (toRemove == null)
                {
                    foreach (AxTableFieldGroupExtension fge in axExt.FieldGroupExtensions)
                    {
                        if (string.Equals(fge.Name, groupName, StringComparison.OrdinalIgnoreCase))
                            throw new InvalidOperationException(
                                $"Field group '{groupName}' is not defined by table-extension '{tableName}' — it is a BASE-table group that this extension only adds fields to (<FieldGroupExtensions>). " +
                                "Removing the whole group would have to happen on the base table.");
                    }
                    throw new InvalidOperationException($"Field group '{groupName}' not found on table-extension '{tableName}'");
                }
                axExt.FieldGroups.Remove(toRemove);
                var extProvider = _provider.TableExtensions as IMetaTableExtensionProvider
                    ?? throw new InvalidOperationException("IMetaTableExtensionProvider not available");
                extProvider.Update(axExt, msi);
                return new { success = true, operation = "remove-field-group", objectName = tableName, groupName, api = "IMetaTableExtensionProvider.Update" };
            }

            throw new ArgumentException($"Table or table-extension '{tableName}' not found");
        }

        /// <summary>
        /// Adds a field reference to a field group on a table or table-extension.
        ///
        /// A table-extension has TWO places a field reference can go, and they are not
        /// interchangeable:
        ///   • &lt;FieldGroups&gt;          — groups the extension itself defines (must already exist).
        ///   • &lt;FieldGroupExtensions&gt; — entries that append fields to a group owned by the BASE
        ///                              table. Set extendBaseFieldGroup for this; the entry is
        ///                              created on demand, since a base-table group is by
        ///                              definition absent from the extension's own collection.
        /// Picking the wrong one is silent: the field lands in the file but never surfaces on
        /// the base table's forms.
        /// </summary>
        public object AddFieldToFieldGroup(string tableName, string groupName, string fieldName, bool extendBaseFieldGroup = false)
        {
            var axTable = _provider.Tables.Read(tableName);
            if (axTable != null)
            {
                // A plain table owns its groups outright — there is nothing to "extend".
                // Reject rather than ignore: silently dropping the flag is the defect this
                // parameter was added to fix.
                if (extendBaseFieldGroup)
                    throw new ArgumentException(
                        $"extendBaseFieldGroup applies to table-extensions only — '{tableName}' is a table, which owns its field groups directly. Omit the flag.");

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
                return new { success = true, operation = "add-field-to-field-group", objectName = tableName, groupName, fieldName, extendBaseFieldGroup = false, api = "IMetaTableProvider.Update" };
            }

            var axExt = _provider.TableExtensions.Read(tableName);
            if (axExt != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.TableExtensions, tableName);
                var extProvider = _provider.TableExtensions as IMetaTableExtensionProvider
                    ?? throw new InvalidOperationException("IMetaTableExtensionProvider not available");

                if (extendBaseFieldGroup)
                {
                    AxTableFieldGroupExtension? targetFge = null;
                    foreach (AxTableFieldGroupExtension fge in axExt.FieldGroupExtensions)
                    {
                        if (string.Equals(fge.Name, groupName, StringComparison.OrdinalIgnoreCase))
                        { targetFge = fge; break; }
                    }
                    if (targetFge == null)
                    {
                        // FieldGroupExtensions is a KeyedObjectCollection — adding a second entry
                        // under an existing key fails inside the SDK, so create only when absent.
                        targetFge = new AxTableFieldGroupExtension { Name = groupName };
                        axExt.FieldGroupExtensions.Add(targetFge);
                    }
                    foreach (AxTableFieldGroupField existing in targetFge.Fields)
                    {
                        if (string.Equals(existing.DataField, fieldName, StringComparison.OrdinalIgnoreCase))
                            return new { success = true, operation = "add-field-to-field-group", objectName = tableName, groupName, fieldName, extendBaseFieldGroup = true, skipped = true, reason = $"field '{fieldName}' already in base-group extension '{groupName}'", api = "IMetaTableExtensionProvider.Update" };
                    }
                    targetFge.Fields.Add(new AxTableFieldGroupField { DataField = fieldName });
                    extProvider.Update(axExt, msi);
                    return new { success = true, operation = "add-field-to-field-group", objectName = tableName, groupName, fieldName, extendBaseFieldGroup = true, api = "IMetaTableExtensionProvider.Update" };
                }

                AxTableFieldGroup? targetFg = null;
                foreach (AxTableFieldGroup fg in axExt.FieldGroups)
                {
                    if (string.Equals(fg.Name, groupName, StringComparison.OrdinalIgnoreCase))
                    { targetFg = fg; break; }
                }
                if (targetFg == null)
                    throw new InvalidOperationException(
                        $"Field group '{groupName}' not found on table-extension '{tableName}'. " +
                        "If it is a group defined by the BASE table, pass extendBaseFieldGroup=true to append the field through <FieldGroupExtensions> instead.");

                targetFg.AddField(new AxTableFieldGroupField { DataField = fieldName });
                extProvider.Update(axExt, msi);
                return new { success = true, operation = "add-field-to-field-group", objectName = tableName, groupName, fieldName, extendBaseFieldGroup = false, api = "IMetaTableExtensionProvider.Update" };
            }

            throw new ArgumentException($"Table or table-extension '{tableName}' not found");
        }

        // ========================
        // TABLE FIELD MODIFY / RENAME / REMOVE / REPLACE-ALL
        // ========================

        /// <summary>Modifies properties of an existing field on a table or table-extension.</summary>
        public object ModifyField(string tableName, string fieldName, Dictionary<string, string>? properties)
        {
            var axTable = _provider.Tables.Read(tableName);
            if (axTable != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.Tables, tableName);
                AxTableField? target = null;
                foreach (AxTableField f in axTable.Fields)
                {
                    if (string.Equals(f.Name, fieldName, StringComparison.OrdinalIgnoreCase))
                    { target = f; break; }
                }
                if (target == null)
                    throw new InvalidOperationException($"Field '{fieldName}' not found on table '{tableName}'");
                var applied = new List<string>();
                if (properties != null)
                {
                    foreach (var kv in properties)
                        if (SetTableFieldProperty(target, kv.Key, kv.Value)) applied.Add(kv.Key);
                }
                RequireSomethingApplied("modify-field", tableName, fieldName, properties, applied, SupportedTableFieldProperties);
                ((IMetaTableProvider)_provider.Tables).Update(axTable, msi);
                return new { success = true, operation = "modify-field", objectName = tableName, fieldName, applied, api = "IMetaTableProvider.Update" };
            }

            var axExt = _provider.TableExtensions.Read(tableName);
            if (axExt != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.TableExtensions, tableName);
                AxTableField? target = null;
                foreach (AxTableField f in axExt.Fields)
                {
                    if (string.Equals(f.Name, fieldName, StringComparison.OrdinalIgnoreCase))
                    { target = f; break; }
                }
                if (target == null)
                    throw new InvalidOperationException($"Field '{fieldName}' not found on table-extension '{tableName}'");
                var applied = new List<string>();
                if (properties != null)
                {
                    foreach (var kv in properties)
                        if (SetTableFieldProperty(target, kv.Key, kv.Value)) applied.Add(kv.Key);
                }
                RequireSomethingApplied("modify-field", tableName, fieldName, properties, applied, SupportedTableFieldProperties);
                var extProvider = _provider.TableExtensions as IMetaTableExtensionProvider
                    ?? throw new InvalidOperationException("IMetaTableExtensionProvider not available");
                extProvider.Update(axExt, msi);
                return new { success = true, operation = "modify-field", objectName = tableName, fieldName, applied, api = "IMetaTableExtensionProvider.Update" };
            }

            throw new ArgumentException($"Table or table-extension '{tableName}' not found");
        }

        /// <summary>
        /// Renames a field on a table or table-extension, repointing every reference to it
        /// that lives on the same object: indexes, full-text indexes, field groups, relation
        /// constraints, Map connections and (for tables) TitleField1/2.
        ///
        /// Relations, FullTextIndexes and Mappings used to be skipped, and the reported
        /// success was the whole problem: the rename left them pointing at a field name that
        /// no longer exists, so the very next build failed on the renamed table while the
        /// tool had already said ✅ and moved on. Nothing here can be left to the caller —
        /// a dangling DataField is not a warning in D365FO, it is a compile error.
        ///
        /// Out of scope, and deliberately so: references from OTHER objects (a foreign
        /// table's relation whose RelatedField names this field, forms, X++ code). They are
        /// separate files under separate model ownership; find_references over the xref
        /// database is the tool for those.
        /// </summary>
        public object RenameField(string tableName, string oldName, string newName)
        {
            var axTable = _provider.Tables.Read(tableName);
            if (axTable != null)
            {
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

                var repointed = new Dictionary<string, int>
                {
                    ["indexes"] = RepointIndexFields(axTable.Indexes, oldName, newName),
                    ["fullTextIndexes"] = RepointFullTextIndexFields(axTable.FullTextIndexes, oldName, newName),
                    ["fieldGroups"] = RepointFieldGroupFields(axTable.FieldGroups, oldName, newName),
                    ["relationConstraints"] = RepointRelationFields(axTable.Relations, oldName, newName),
                    ["mappingConnections"] = RepointMappingFields(axTable.Mappings, oldName, newName),
                };

                // TitleField1/2 hold a field name directly (no wrapper element); extensions
                // have no equivalent because the base table owns those properties.
                var titleFields = 0;
                if (string.Equals(axTable.TitleField1, oldName, StringComparison.OrdinalIgnoreCase))
                { axTable.TitleField1 = newName; titleFields++; }
                if (string.Equals(axTable.TitleField2, oldName, StringComparison.OrdinalIgnoreCase))
                { axTable.TitleField2 = newName; titleFields++; }
                repointed["titleFields"] = titleFields;

                ((IMetaTableProvider)_provider.Tables).Update(axTable, msi);
                return new { success = true, operation = "rename-field", objectName = tableName, oldName, newName, repointedReferences = repointed, api = "IMetaTableProvider.Update" };
            }

            var axExt = _provider.TableExtensions.Read(tableName);
            if (axExt != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.TableExtensions, tableName);
                AxTableField? target = null;
                foreach (AxTableField f in axExt.Fields)
                {
                    if (string.Equals(f.Name, oldName, StringComparison.OrdinalIgnoreCase))
                    { target = f; break; }
                }
                if (target == null)
                    throw new InvalidOperationException($"Field '{oldName}' not found on table-extension '{tableName}'");
                target.Name = newName;

                // An extension carries the same collections plus two of its own:
                // FieldGroupExtensions (fields appended to a BASE table's group) and
                // RelationExtensions (constraints appended to a BASE table's relation).
                // Both can name a field this extension declares, so both must move too.
                var repointedExt = new Dictionary<string, int>
                {
                    ["indexes"] = RepointIndexFields(axExt.Indexes, oldName, newName),
                    ["fullTextIndexes"] = RepointFullTextIndexFields(axExt.FullTextIndexes, oldName, newName),
                    ["fieldGroups"] = RepointFieldGroupFields(axExt.FieldGroups, oldName, newName),
                    ["relationConstraints"] = RepointRelationFields(axExt.Relations, oldName, newName),
                    ["mappingConnections"] = RepointMappingFields(axExt.Mappings, oldName, newName),
                };

                var fieldGroupExtensions = 0;
                foreach (AxTableFieldGroupExtension fge in axExt.FieldGroupExtensions)
                    fieldGroupExtensions += RepointFieldGroupFieldList(fge.Fields, oldName, newName);
                repointedExt["fieldGroupExtensions"] = fieldGroupExtensions;

                var relationExtensions = 0;
                foreach (AxTableRelationExtension re in axExt.RelationExtensions)
                    relationExtensions += RepointConstraintFields(re.RelationConstraints, oldName, newName);
                repointedExt["relationExtensions"] = relationExtensions;

                var extProvider = _provider.TableExtensions as IMetaTableExtensionProvider
                    ?? throw new InvalidOperationException("IMetaTableExtensionProvider not available");
                extProvider.Update(axExt, msi);
                return new { success = true, operation = "rename-field", objectName = tableName, oldName, newName, repointedReferences = repointedExt, api = "IMetaTableExtensionProvider.Update" };
            }

            throw new ArgumentException($"Table or table-extension '{tableName}' not found");
        }

        // ── rename-field reference repointing ──
        // One helper per collection that can name a table field, each returning how many
        // references it moved so RenameField can report the repair instead of asserting it.

        private static int RepointIndexFields(IEnumerable<AxTableIndex> indexes, string oldName, string newName)
        {
            var moved = 0;
            foreach (AxTableIndex idx in indexes)
            {
                foreach (AxTableIndexField ixf in idx.Fields)
                {
                    if (string.Equals(ixf.DataField, oldName, StringComparison.OrdinalIgnoreCase))
                    { ixf.DataField = newName; moved++; }
                }
            }
            return moved;
        }

        /// <summary>
        /// FullTextIndexes is a collection of its own (AxTableFullTextIndex), separate from
        /// Indexes, but its entries are the same AxTableIndexField elements.
        /// </summary>
        private static int RepointFullTextIndexFields(IEnumerable<AxTableFullTextIndex> indexes, string oldName, string newName)
        {
            var moved = 0;
            foreach (AxTableFullTextIndex idx in indexes)
            {
                foreach (AxTableIndexField ixf in idx.Fields)
                {
                    if (string.Equals(ixf.DataField, oldName, StringComparison.OrdinalIgnoreCase))
                    { ixf.DataField = newName; moved++; }
                }
            }
            return moved;
        }

        private static int RepointFieldGroupFields(IEnumerable<AxTableFieldGroup> groups, string oldName, string newName)
        {
            var moved = 0;
            foreach (AxTableFieldGroup fg in groups)
                moved += RepointFieldGroupFieldList(fg.Fields, oldName, newName);
            return moved;
        }

        private static int RepointFieldGroupFieldList(IEnumerable<AxTableFieldGroupField> fields, string oldName, string newName)
        {
            var moved = 0;
            foreach (AxTableFieldGroupField fgf in fields)
            {
                if (string.Equals(fgf.DataField, oldName, StringComparison.OrdinalIgnoreCase))
                { fgf.DataField = newName; moved++; }
            }
            return moved;
        }

        private static int RepointRelationFields(IEnumerable<AxTableRelation> relations, string oldName, string newName)
        {
            var moved = 0;
            foreach (AxTableRelation rel in relations)
                moved += RepointConstraintFields(rel.Constraints, oldName, newName);
            return moved;
        }

        /// <summary>
        /// Only the LOCAL side of a constraint is ours to rename: Field names a column on
        /// this table, RelatedField names one on the related table. Two constraint kinds
        /// carry a local Field (…ConstraintField and …ConstraintFixed); …ConstraintRelatedFixed
        /// has none. The constraint's own Name is left alone — it is an element identifier the
        /// compiler never resolves against the field list, so rewriting it would be churn.
        /// </summary>
        private static int RepointConstraintFields(IEnumerable<AxTableRelationConstraint> constraints, string oldName, string newName)
        {
            var moved = 0;
            foreach (AxTableRelationConstraint c in constraints)
            {
                if (c is AxTableRelationConstraintField cf && string.Equals(cf.Field, oldName, StringComparison.OrdinalIgnoreCase))
                { cf.Field = newName; moved++; }
                else if (c is AxTableRelationConstraintFixed cx && string.Equals(cx.Field, oldName, StringComparison.OrdinalIgnoreCase))
                { cx.Field = newName; moved++; }
            }
            return moved;
        }

        /// <summary>
        /// In an AxTableMapping connection, MapField names the field on the MAP and MapFieldTo
        /// names the field on this table — so a local rename moves MapFieldTo only.
        /// </summary>
        private static int RepointMappingFields(IEnumerable<AxTableMapping> mappings, string oldName, string newName)
        {
            var moved = 0;
            foreach (AxTableMapping m in mappings)
            {
                foreach (AxTableMappingConnection c in m.Connections)
                {
                    if (string.Equals(c.MapFieldTo, oldName, StringComparison.OrdinalIgnoreCase))
                    { c.MapFieldTo = newName; moved++; }
                }
            }
            return moved;
        }

        /// <summary>Removes a field from a table or table-extension.</summary>
        public object RemoveField(string tableName, string fieldName)
        {
            var axTable = _provider.Tables.Read(tableName);
            if (axTable != null)
            {
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

            var axExt = _provider.TableExtensions.Read(tableName);
            if (axExt != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.TableExtensions, tableName);
                AxTableField? toRemove = null;
                foreach (AxTableField f in axExt.Fields)
                {
                    if (string.Equals(f.Name, fieldName, StringComparison.OrdinalIgnoreCase))
                    { toRemove = f; break; }
                }
                if (toRemove == null)
                    throw new InvalidOperationException($"Field '{fieldName}' not found on table-extension '{tableName}'");
                axExt.Fields.Remove(toRemove);
                var extProvider = _provider.TableExtensions as IMetaTableExtensionProvider
                    ?? throw new InvalidOperationException("IMetaTableExtensionProvider not available");
                extProvider.Update(axExt, msi);
                return new { success = true, operation = "remove-field", objectName = tableName, fieldName, api = "IMetaTableExtensionProvider.Update" };
            }

            throw new ArgumentException($"Table or table-extension '{tableName}' not found");
        }

        /// <summary>Replaces ALL fields on a table or table-extension (clear + re-add). Use for bulk field rewrite.</summary>
        public object ReplaceAllFields(string tableName, List<WriteFieldParam> fields)
        {
            var axTable = _provider.Tables.Read(tableName);
            if (axTable != null)
            {
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

            var axExt = _provider.TableExtensions.Read(tableName);
            if (axExt != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.TableExtensions, tableName);
                // Clear existing fields
                var existing = new List<AxTableField>();
                foreach (AxTableField f in axExt.Fields) existing.Add(f);
                foreach (var f in existing) axExt.Fields.Remove(f);
                // Add new fields
                foreach (var fp in fields)
                {
                    var axField = CreateTableField(fp);
                    axExt.Fields.Add(axField);
                }
                var extProvider = _provider.TableExtensions as IMetaTableExtensionProvider
                    ?? throw new InvalidOperationException("IMetaTableExtensionProvider not available");
                extProvider.Update(axExt, msi);
                return new { success = true, operation = "replace-all-fields", objectName = tableName, fieldCount = fields.Count, api = "IMetaTableExtensionProvider.Update" };
            }

            throw new ArgumentException($"Table or table-extension '{tableName}' not found");
        }

        // ========================
        // ENUM VALUE OPERATIONS
        // ========================

        /// <summary>
        /// Adds a value to an enum or an enum-extension.
        ///
        /// The extension branch is not a nicety: a standard enum marked IsExtensible can
        /// only take new values through an AxEnumExtension, so without it the ONLY write
        /// path to a shipped enum was create-time (CreateEnumExtension) — an extension with
        /// a wrong or missing value had no repair path at all.
        ///
        /// Base-first resolution is what makes the ownership guard necessary here rather
        /// than optional. Ask for a value on "SalesStatus" and Enums.Read hits Microsoft's
        /// enum; the extension branch is never reached, because an extension is named
        /// "SalesStatus.&lt;Something&gt;Extension" and no caller asking for the base ever
        /// spells that. So the natural request — "add a value to this shipped enum" — wrote
        /// the value straight into ApplicationSuite and reported success.
        /// </summary>
        public object AddEnumValue(string enumName, string valueName, int value, string? label, string? countryRegionCodes = null)
        {
            var axVal = new AxEnumValue { Name = valueName, Value = value };
            if (!string.IsNullOrEmpty(label)) axVal.Label = label;
            if (!string.IsNullOrEmpty(countryRegionCodes)) axVal.CountryRegionCodes = countryRegionCodes;

            var axEnum = _provider.Enums.Read(enumName);
            if (axEnum != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.Enums, enumName);
                AssertModelWritable(msi, "add-enum-value", enumName,
                    $"Extend it instead: create an enum-extension of '{enumName}' in your own model " +
                    "(the base enum must have IsExtensible=Yes), then add the value to that extension.");
                axEnum.AddEnumValue(axVal);
                ((IMetaEnumProvider)_provider.Enums).Update(axEnum, msi);
                return new { success = true, operation = "add-enum-value", objectName = enumName, valueName, value, api = "IMetaEnumProvider.Update" };
            }

            var axExt = _provider.EnumExtensions.Read(enumName);
            if (axExt != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.EnumExtensions, enumName);
                // An extension is the sanctioned route, but not when the extension itself is
                // Microsoft's — that is still the base application.
                AssertModelWritable(msi, "add-enum-value", enumName,
                    "Create your own enum-extension of the same base enum and add the value there.");
                axExt.EnumValues.Add(axVal);
                var extProvider = _provider.EnumExtensions as IMetaEnumExtensionProvider
                    ?? throw new InvalidOperationException("IMetaEnumExtensionProvider not available");
                extProvider.Update(axExt, msi);
                return new { success = true, operation = "add-enum-value", objectName = enumName, valueName, value, api = "IMetaEnumExtensionProvider.Update" };
            }

            throw new ArgumentException($"Enum or enum-extension '{enumName}' not found");
        }

        /// <summary>Modifies properties of an existing value on an enum or enum-extension.</summary>
        public object ModifyEnumValue(string enumName, string valueName, Dictionary<string, string>? properties)
        {
            var axEnum = _provider.Enums.Read(enumName);
            if (axEnum != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.Enums, enumName);
                var target = FindEnumValue(axEnum.EnumValues, valueName)
                    ?? throw new InvalidOperationException($"Enum value '{valueName}' not found on enum '{enumName}'");
                var applied = ApplyEnumValueProperties(target, properties);
                RequireSomethingApplied("modify-enum-value", enumName, valueName, properties, applied, SupportedEnumValueProperties);
                ((IMetaEnumProvider)_provider.Enums).Update(axEnum, msi);
                return new { success = true, operation = "modify-enum-value", objectName = enumName, valueName, applied, api = "IMetaEnumProvider.Update" };
            }

            var axExt = _provider.EnumExtensions.Read(enumName);
            if (axExt != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.EnumExtensions, enumName);
                var target = FindEnumValue(axExt.EnumValues, valueName)
                    ?? throw new InvalidOperationException(
                        $"Enum value '{valueName}' not found on enum-extension '{enumName}'. " +
                        "An extension can only modify values it declares itself — a value on the BASE enum is not editable from here.");
                var applied = ApplyEnumValueProperties(target, properties);
                RequireSomethingApplied("modify-enum-value", enumName, valueName, properties, applied, SupportedEnumValueProperties);
                var extProvider = _provider.EnumExtensions as IMetaEnumExtensionProvider
                    ?? throw new InvalidOperationException("IMetaEnumExtensionProvider not available");
                extProvider.Update(axExt, msi);
                return new { success = true, operation = "modify-enum-value", objectName = enumName, valueName, applied, api = "IMetaEnumExtensionProvider.Update" };
            }

            throw new ArgumentException($"Enum or enum-extension '{enumName}' not found");
        }

        /// <summary>
        /// helpText is deliberately absent: AxEnumValue has no HelpText in the metamodel
        /// (only AxEnum does), so there is nothing to write it to.
        /// </summary>
        private static readonly string[] SupportedEnumValueProperties =
            { "label", "value", "name", "countryRegionCodes", "configurationKey" };

        private static AxEnumValue? FindEnumValue(IEnumerable<AxEnumValue> values, string valueName)
        {
            foreach (AxEnumValue v in values)
            {
                if (string.Equals(v.Name, valueName, StringComparison.OrdinalIgnoreCase))
                    return v;
            }
            return null;
        }

        private static List<string> ApplyEnumValueProperties(AxEnumValue target, Dictionary<string, string>? properties)
        {
            var applied = new List<string>();
            if (properties == null) return applied;

            foreach (var kv in properties)
            {
                switch (kv.Key.ToLowerInvariant())
                {
                    case "label": target.Label = kv.Value; applied.Add(kv.Key); break;
                    case "value":
                        if (int.TryParse(kv.Value, out var iv)) { target.Value = iv; applied.Add(kv.Key); }
                        break;
                    case "name": target.Name = kv.Value; applied.Add(kv.Key); break;
                    case "countryregioncodes": target.CountryRegionCodes = kv.Value; applied.Add(kv.Key); break;
                    case "configurationkey": target.ConfigurationKey = kv.Value; applied.Add(kv.Key); break;
                    default:
                        Console.Error.WriteLine($"[WriteService] Unknown enum value property: {kv.Key}");
                        break;
                }
            }
            return applied;
        }

        /// <summary>Removes a value from an enum.</summary>
        public object RemoveEnumValue(string enumName, string valueName)
        {
            var axEnum = _provider.Enums.Read(enumName);
            if (axEnum != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.Enums, enumName);
                var toRemove = FindEnumValue(axEnum.EnumValues, valueName)
                    ?? throw new InvalidOperationException($"Enum value '{valueName}' not found on enum '{enumName}'");
                axEnum.EnumValues.Remove(toRemove);
                ((IMetaEnumProvider)_provider.Enums).Update(axEnum, msi);
                return new { success = true, operation = "remove-enum-value", objectName = enumName, valueName, api = "IMetaEnumProvider.Update" };
            }

            var axExt = _provider.EnumExtensions.Read(enumName);
            if (axExt != null)
            {
                var msi = GetModelSaveInfoForObject(_provider.EnumExtensions, enumName);
                var toRemove = FindEnumValue(axExt.EnumValues, valueName)
                    ?? throw new InvalidOperationException(
                        $"Enum value '{valueName}' not found on enum-extension '{enumName}'. " +
                        "An extension can only remove values it declares itself — a value on the BASE enum stays.");
                axExt.EnumValues.Remove(toRemove);
                var extProvider = _provider.EnumExtensions as IMetaEnumExtensionProvider
                    ?? throw new InvalidOperationException("IMetaEnumExtensionProvider not available");
                extProvider.Update(axExt, msi);
                return new { success = true, operation = "remove-enum-value", objectName = enumName, valueName, api = "IMetaEnumExtensionProvider.Update" };
            }

            throw new ArgumentException($"Enum or enum-extension '{enumName}' not found");
        }

        // ========================
        // TABLE-EXTENSION: ADD FIELD MODIFICATION
        // ========================

        /// <summary>
        /// Sets a property override, creating the entry or updating it in place.
        ///
        /// Every "modification" collection on an extension — PropertyModifications,
        /// FieldModifications, RelationModifications — bottoms out in AxPropertyModification,
        /// a flat { Name, Value } pair. Overrides are values in that list, never CLR
        /// properties on the modification object: an AxExtensionModification has exactly
        /// Name, Parent and PropertyModifications and nothing else.
        /// </summary>
        private static void UpsertPropertyModification(
            Microsoft.Dynamics.AX.Metadata.Core.Collections.KeyedObjectCollection<AxPropertyModification> mods,
            string name, string value)
        {
            foreach (AxPropertyModification pm in mods)
            {
                if (string.Equals(pm.Name, name, StringComparison.OrdinalIgnoreCase))
                { pm.Value = value; return; }
            }
            mods.Add(new AxPropertyModification { Name = name, Value = value });
        }

        /// <summary>
        /// Finds or creates the AxExtensionModification carrying overrides for one member
        /// (a base-table field, or a base-table relation) of an extension.
        /// The collections are keyed, so a duplicate Add fails inside the SDK.
        /// </summary>
        private static AxExtensionModification GetOrAddExtensionModification(
            Microsoft.Dynamics.AX.Metadata.Core.Collections.KeyedObjectCollection<AxExtensionModification> mods,
            string memberName)
        {
            foreach (AxExtensionModification m in mods)
            {
                if (string.Equals(m.Name, memberName, StringComparison.OrdinalIgnoreCase))
                    return m;
            }
            var created = new AxExtensionModification { Name = memberName };
            mods.Add(created);
            return created;
        }

        /// <summary>
        /// Adds or updates a FieldModification entry in a table-extension — overriding Label
        /// or Mandatory on a base-table field.
        ///
        /// This used to run on `dynamic`, on the stated belief that the SDK "does not expose
        /// FieldModifications statically". It does: AxTableExtension.FieldModifications is a
        /// KeyedObjectCollection&lt;AxExtensionModification&gt;. Worse, the dynamic code then
        /// assigned `.Label` and `.Mandatory` on that element — properties AxExtensionModification
        /// does not have — and neither AxTableFieldModification nor AxTableExtensionFieldModification
        /// exists in the metamodel to supply them. Every call therefore threw
        /// RuntimeBinderException at the point of assignment; nothing in CI compiles the bridge,
        /// so it never surfaced. Overrides are AxPropertyModification { Name, Value } entries.
        /// </summary>
        public object AddFieldModification(string extensionName, string fieldName,
            string? fieldLabel, bool? fieldMandatory)
        {
            var axExt = _provider.TableExtensions.Read(extensionName)
                ?? throw new ArgumentException($"Table extension '{extensionName}' not found");
            var msi = GetModelSaveInfoForObject(_provider.TableExtensions, extensionName);

            if (fieldLabel == null && !fieldMandatory.HasValue)
                throw new ArgumentException(
                    $"add-field-modification on '{extensionName}' was given neither fieldLabel nor fieldMandatory — nothing to override.");

            var mod = GetOrAddExtensionModification(axExt.FieldModifications, fieldName);
            var applied = new List<string>();
            if (fieldLabel != null)
            {
                UpsertPropertyModification(mod.PropertyModifications, "Label", fieldLabel);
                applied.Add("Label");
            }
            if (fieldMandatory.HasValue)
            {
                UpsertPropertyModification(mod.PropertyModifications, "Mandatory", fieldMandatory.Value ? "Yes" : "No");
                applied.Add("Mandatory");
            }

            ((IMetaTableExtensionProvider)_provider.TableExtensions).Update(axExt, msi);
            return new { success = true, operation = "add-field-modification", objectName = extensionName, fieldName,
                fieldLabel, fieldMandatory, applied, api = "IMetaTableExtensionProvider.Update" };
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

            var itemType = (menuItemType ?? "display").ToLowerInvariant();

            // Idempotency: menu Elements is a KeyedObjectCollection keyed by Name. Adding a
            // duplicate fails inside the SDK and surfaces as an opaque NullReferenceException,
            // so skip when the item is already on the menu (it is then already correct).
            if (axMenu.Elements != null)
            {
                foreach (var existing in axMenu.Elements)
                {
                    if (string.Equals((string)((dynamic)existing).Name, menuItemName, StringComparison.OrdinalIgnoreCase))
                        return new { success = true, operation = "add-menu-item-to-menu", objectName = menuName, menuItemName, menuItemType = itemType, skipped = true, reason = $"menu item '{menuItemName}' already on menu '{menuName}'", api = "IMetaMenuProvider.Update" };
                }
            }

            // AxMenu holds AxMenuElement children in `Elements` (added via AddElement) — NOT
            // a `MenuItems` collection. A menu-item reference is an AxMenuElementMenuItem whose
            // MenuItemType (Display/Action/Output) discriminates the referenced item kind.
            // NOTE: MenuItemType lives in the Core assembly (Microsoft.Dynamics.AX.Metadata.Core),
            // a DIFFERENT assembly than AxMenuElementMenuItem — reference both directly rather
            // than via typeof(AxClass).Assembly.GetType(), which only sees the one assembly.
            var element = new AxMenuElementMenuItem
            {
                Name = menuItemName,
                MenuItemName = menuItemName,
                MenuItemType = itemType switch
                {
                    "display" => Microsoft.Dynamics.AX.Metadata.Core.MetaModel.MenuItemType.Display,
                    "action" => Microsoft.Dynamics.AX.Metadata.Core.MetaModel.MenuItemType.Action,
                    "output" => Microsoft.Dynamics.AX.Metadata.Core.MetaModel.MenuItemType.Output,
                    _ => throw new ArgumentException($"Unsupported menu item type: '{menuItemType}'. Use 'display', 'action', or 'output'."),
                },
            };
            axMenu.AddElement(element);

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
            // Forms is keyed by plain form names; a form EXTENSION lives in FormExtensions
            // under its dotted "Base.Suffix" name and wraps each added control in an
            // AxFormExtensionControl, which this method does not build. Say so instead of
            // reporting the lookup miss as "form not found".
            if (formName.Contains('.'))
                throw new ArgumentException(
                    $"'{formName}' is a form extension — AddControl only handles base forms. " +
                    "Form extensions are written by the caller's direct-XML path, which produces the " +
                    "required AxFormExtensionControl wrapper.");

            var axForm = _provider.Forms.Read(formName)
                ?? throw new ArgumentException($"Form '{formName}' not found");
            var msi = GetModelSaveInfoForObject(_provider.Forms, formName);

            // Navigate to parent control in the design tree
            var design = axForm.Design;
            var parent = FindControlRecursive(design, parentControl);

            // FindControlRecursive only ever walks design.Controls, so it can never return the
            // design ROOT. Fall back to the design itself when parentControl is a design-root
            // sentinel ("Design", the form name, empty/omitted, ...) — otherwise a form whose
            // design has no controls yet can never receive its FIRST top-level control, which
            // blocked every form-lifecycle eval case (see FormAuthoringDefaults).
            // A real control wins over the sentinel: the recursive lookup is tried first, so a
            // control genuinely NAMED "Design" still resolves to itself.
            if (parent == null && FormAuthoringDefaults.IsDesignRootSentinel(parentControl, formName))
                parent = design;

            if (parent == null)
                throw new InvalidOperationException(
                    $"Parent control '{parentControl}' not found in form '{formName}'. " +
                    "Pass parentControl=\"Design\" (or omit it) to add a control at the top level of the form design.");

            // Create the control using reflection (AxFormControl is abstract)
            var control = CreateFormControl(controlType, controlName, dataSource, dataField, label, out var unsupportedProperties);
            AddChildControl(parent, control);

            ((IMetaFormProvider)_provider.Forms).Update(axForm, msi);
            return new
            {
                success = true, operation = "add-control", objectName = formName, controlName, parentControl, controlType,
                // Same contract as the create ops: what was asked for and did NOT apply is
                // named, so an unbound control cannot pass for a bound one.
                unsupportedProperties,
                api = "IMetaFormProvider.Update",
            };
        }

        /// <summary>
        /// Adds a data source to a form or a form-extension.
        ///
        /// AxFormExtension.DataSources holds the very same AxFormDataSourceRoot element type
        /// as AxForm.DataSources (verified against this VM's metamodel), so the extension
        /// branch reuses CreateFormDataSourceRoot unchanged — only the provider differs.
        /// </summary>
        public object AddDataSource(string objectType, string objectName, string dsName, string table,
            string? joinSource, string? linkType)
        {
            switch (objectType.ToLowerInvariant())
            {
                case "form-extension":
                {
                    var axExt = _provider.FormExtensions.Read(objectName)
                        ?? throw new ArgumentException($"Form extension '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.FormExtensions, objectName);

                    // Same idempotency rule as the form branch below: skip on a name match,
                    // and on a different-named data source already bound to the same table.
                    foreach (AxFormDataSourceRoot existing in axExt.DataSources)
                    {
                        if (string.Equals(existing.Name, dsName, StringComparison.OrdinalIgnoreCase))
                            return new { success = true, operation = "add-data-source", objectType, objectName, dsName, table, skipped = true, reason = $"data source '{dsName}' already exists", api = "IMetaFormExtensionProvider.Update" };
                        if (string.Equals(existing.Table, table, StringComparison.OrdinalIgnoreCase))
                            return new { success = true, operation = "add-data-source", objectType, objectName, dsName, table, skipped = true, reason = $"data source '{existing.Name}' already binds table '{table}'", api = "IMetaFormExtensionProvider.Update" };
                    }

                    axExt.DataSources.Add((AxFormDataSourceRoot)CreateFormDataSourceRoot(dsName, table, joinSource, linkType));

                    var extProvider = _provider.FormExtensions as IMetaFormExtensionProvider
                        ?? throw new InvalidOperationException("IMetaFormExtensionProvider not available");
                    extProvider.Update(axExt, msi);
                    return new { success = true, operation = "add-data-source", objectType, objectName, dsName, table, joinSource, linkType, api = "IMetaFormExtensionProvider.Update" };
                }
                case "form":
                {
                    var axForm = _provider.Forms.Read(objectName)
                        ?? throw new ArgumentException($"Form '{objectName}' not found");
                    var msi = GetModelSaveInfoForObject(_provider.Forms, objectName);

                    // Idempotency: don't append a duplicate. If a data source with the same
                    // NAME already exists, skip (it may be a template stub already bound to the
                    // right table). If a DIFFERENT-named data source already binds the same
                    // TABLE, skip too — adding a second binding to the same table is almost
                    // always an accident (a stub the caller meant to replace, not duplicate).
                    foreach (var existing in axForm.DataSources)
                    {
                        dynamic dyn = existing;
                        if (string.Equals((string)dyn.Name, dsName, StringComparison.OrdinalIgnoreCase))
                            return new { success = true, operation = "add-data-source", objectType, objectName, dsName, table, skipped = true, reason = $"data source '{dsName}' already exists", api = "IMetaFormProvider.Update" };
                        if (string.Equals((string)dyn.Table, table, StringComparison.OrdinalIgnoreCase))
                            return new { success = true, operation = "add-data-source", objectType, objectName, dsName, table, skipped = true, reason = $"data source '{(string)dyn.Name}' already binds table '{table}'", api = "IMetaFormProvider.Update" };
                    }

                    axForm.AddDataSource(CreateFormDataSourceRoot(dsName, table, joinSource, linkType));

                    ((IMetaFormProvider)_provider.Forms).Update(axForm, msi);
                    return new { success = true, operation = "add-data-source", objectType, objectName, dsName, table, joinSource, linkType, api = "IMetaFormProvider.Update" };
                }
                default:
                    throw new ArgumentException($"add-data-source not supported for objectType '{objectType}' via bridge");
            }
        }

        // ========================
        // HELPERS: Table Field Creation
        // ========================

        /// <summary>
        /// Refuse to write an &lt;ExtendedDataType&gt; naming an EDT the provider does not know.
        /// The metadata writer accepts any string here, so a misspelled EDT serialized fine
        /// and the create/add-field returned success — the only symptom was a later build
        /// error on a different object.
        ///
        /// Deliberately fails OPEN when the provider itself throws (an Exists() that cannot
        /// answer is not evidence the EDT is missing, and blocking a valid write on a
        /// provider hiccup is a worse failure than the one this guards).
        /// </summary>
        private void RequireExtendedDataTypeExists(string fieldName, string edtName, string what)
        {
            bool known;
            try { known = _provider.Edts.Exists(edtName); }
            catch { return; }
            if (known) return;
            throw new ArgumentException(
                $"Field '{fieldName}': {what} — nothing was written. " +
                "Check the spelling with search(type=\"edt\"), or create the EDT first. " +
                "For an ENUM field pass enumType (the enum name) instead — an enum-typed field needs no EDT.");
        }

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
                    // fieldType may be an EDT name (not a recognized base type keyword).
                    // When edt is not set separately, treat fieldType as the EDT name — but
                    // only if that EDT actually exists. It used to be copied in unchecked, so
                    // a typo ("Iteger" for "Integer") produced an AxTableFieldString carrying
                    // ExtendedDataType="Iteger", written and reported as success; the caller
                    // learned about it from an unrelated compile error later.
                    if (string.IsNullOrEmpty(f.Edt) && !string.IsNullOrEmpty(f.FieldType))
                    {
                        RequireExtendedDataTypeExists(f.Name, f.FieldType!,
                            $"type '{f.FieldType}' is neither a base type (String, Integer, Int64, Real, Date, " +
                            "UtcDateTime, Enum, Container, Guid) nor an existing EDT");
                        axField.ExtendedDataType = f.FieldType;
                    }
                    break;
            }

            axField.Name = f.Name;
            if (!string.IsNullOrEmpty(f.Edt))
            {
                RequireExtendedDataTypeExists(f.Name, f.Edt!, $"extended data type '{f.Edt}' does not exist");
                axField.ExtendedDataType = f.Edt;
            }
            if (!string.IsNullOrEmpty(f.Label)) axField.Label = f.Label;
            if (!string.IsNullOrEmpty(f.HelpText)) axField.HelpText = f.HelpText;
            if (f.Mandatory)
                axField.Mandatory = Microsoft.Dynamics.AX.Metadata.Core.MetaModel.NoYes.Yes;

            return axField;
        }

        // ========================
        // HELPERS: Property Setters
        // ========================

        /// <summary>
        /// Sets a known AxClass property. Returns false (not thrown — callers that apply a
        /// whole properties bag at CREATE time, e.g. CreateClass, intentionally skip unknown
        /// keys rather than aborting the whole create) when `prop` is not recognized;
        /// modify-property's SetProperty dispatcher checks this and surfaces a clear error
        /// instead of the false "success" this used to unconditionally report (regression:
        /// eval/corpus/runs/2026-07-06T18__L1-form-basic__f2c8bfe.json,
        /// eval/corpus/runs/2026-07-06T18__L1-map-basic__cb1b73d.json — modify-property
        /// reported success for both a real property AND a deliberately bogus one; neither
        /// case's actual write was verifiable from the reported result).
        /// </summary>
        private bool SetAxClassProperty(AxClass cls, string prop, string value)
        {
            switch (prop.ToLowerInvariant())
            {
                case "extends": cls.Extends = value; break;
                case "isabstract": cls.IsAbstract = ParseBool(value); break;
                case "isfinal": cls.IsFinal = ParseBool(value); break;
                default:
                    Console.Error.WriteLine($"[WriteService] Unknown AxClass property: {prop}");
                    return false;
            }
            return true;
        }

        private bool SetAxTableProperty(AxTable tbl, string prop, string value)
        {
            switch (prop.ToLowerInvariant())
            {
                case "label": tbl.Label = value; break;
                case "developerdocumentation": tbl.DeveloperDocumentation = value; break;
                // ConfigurationKey / FormRef were missing here, so EVERY writer that
                // funnels through this switch (CreateTable, CreateSmartTable,
                // modify-property) discarded them while answering success — the table
                // half of finding #35. Both are plain string properties on AxTable.
                case "configurationkey": tbl.ConfigurationKey = value; break;
                case "formref": tbl.FormRef = value; break;
                case "tablegroup":
                    if (!Enum.TryParse<Microsoft.Dynamics.AX.Metadata.Core.MetaModel.TableGroup>(value, true, out var tg))
                        throw new ArgumentException(
                            $"'{value}' is not a valid TableGroup. Valid values: " +
                            string.Join(", ", Enum.GetNames(typeof(Microsoft.Dynamics.AX.Metadata.Core.MetaModel.TableGroup))) + ".");
                    tbl.TableGroup = tg;
                    break;
                case "cachelookup":
                    if (!Enum.TryParse<Microsoft.Dynamics.AX.Metadata.Core.MetaModel.RecordCacheLevel>(value, true, out var cl))
                        throw new ArgumentException(
                            $"'{value}' is not a valid CacheLookup. Valid values: " +
                            string.Join(", ", Enum.GetNames(typeof(Microsoft.Dynamics.AX.Metadata.Core.MetaModel.RecordCacheLevel))) + ".");
                    tbl.CacheLookup = cl;
                    break;
                case "clusteredindex": tbl.ClusteredIndex = value; break;
                case "primaryindex": tbl.PrimaryIndex = value; break;
                case "replacementkey": tbl.ReplacementKey = value; break;
                case "savedatapercompany":
                    tbl.SaveDataPerCompany = ParseNoYes(value);
                    break;
                // Dual-write's table-side change-tracking prerequisite.
                case "allowrowversionchangetracking":
                    tbl.AllowRowVersionChangeTracking = ParseNoYes(value);
                    break;
                case "createdby": tbl.CreatedBy = ParseNoYes(value); break;
                case "createddatetime": tbl.CreatedDateTime = ParseNoYes(value); break;
                case "createdtransactionid": tbl.CreatedTransactionId = ParseNoYes(value); break;
                case "modifiedby": tbl.ModifiedBy = ParseNoYes(value); break;
                case "modifieddatetime": tbl.ModifiedDateTime = ParseNoYes(value); break;
                case "modifiedtransactionid": tbl.ModifiedTransactionId = ParseNoYes(value); break;
                case "tabletype":
                    if (!Enum.TryParse<Microsoft.Dynamics.AX.Metadata.Core.MetaModel.TableType>(value, true, out var tt))
                        throw new ArgumentException(
                            $"'{value}' is not a valid TableType. Valid values: " +
                            string.Join(", ", Enum.GetNames(typeof(Microsoft.Dynamics.AX.Metadata.Core.MetaModel.TableType))) + ".");
                    tbl.TableType = tt;
                    break;
                case "supportinheritance":
                    tbl.SupportInheritance = ParseNoYes(value);
                    break;
                case "instancerelationtype":
                    // Table-inheritance discriminator: the value is the NAME of the
                    // base table's int64 discriminator field (e.g. DirPartyTable sets
                    // this to its own "InstanceRelationType" field). Requires
                    // SupportInheritance=Yes on the same table.
                    tbl.InstanceRelationType = value;
                    break;
                case "extends": tbl.Extends = value; break;
                case "titlefield1": tbl.TitleField1 = value; break;
                case "titlefield2": tbl.TitleField2 = value; break;
                default:
                    Console.Error.WriteLine($"[WriteService] Unknown AxTable property: {prop}");
                    return false;
            }
            return true;
        }

        private bool SetAxEnumProperty(AxEnum en, string prop, string value)
        {
            switch (prop.ToLowerInvariant())
            {
                case "label": en.Label = value; break;
                case "isextensible":
                    en.IsExtensible = ParseBool(value);
                    break;
                // Was unsupported, so the TS generator's useEnumValue never reached a
                // bridge-created enum: explicit <Value> numbering was written under
                // whatever UseEnumValue the metamodel defaulted to, and the two paths
                // (bridge create vs. TS XML) disagreed about the same payload.
                case "useenumvalue":
                    en.UseEnumValue = ParseNoYes(value);
                    break;
                default:
                    Console.Error.WriteLine($"[WriteService] Unknown AxEnum property: {prop}");
                    return false;
            }
            return true;
        }

        private bool SetAxEdtProperty(AxEdt edt, string prop, string value)
        {
            switch (prop.ToLowerInvariant())
            {
                case "label": edt.Label = value; break;
                case "helptext": edt.HelpText = value; break;
                case "extends": edt.Extends = value; break;
                case "stringsize":
                    // Only AxEdtString has a StringSize. On an int/real/enum EDT there is
                    // nowhere to put it — which used to fall straight through to `return true`,
                    // so "set stringSize=60" on the wrong base type reported success over an
                    // EDT whose length never changed.
                    if (edt is not AxEdtString strEdt) return false;
                    if (!int.TryParse(value, out var ss))
                        throw new ArgumentException($"stringSize must be an integer — got '{value}'.");
                    strEdt.StringSize = ss;
                    break;
                case "referencetable": edt.ReferenceTable = value; break;
                case "basetype": break; // handled at construction time
                default:
                    Console.Error.WriteLine($"[WriteService] Unknown AxEdt property: {prop}");
                    return false;
            }
            return true;
        }

        private bool SetAxQueryProperty(AxQuery q, string prop, string value)
        {
            // AxQuery is abstract — properties may vary by subclass. Use dynamic for safety.
            dynamic dq = q;
            // A subclass that does not carry the property throws on the assignment. That is a
            // property NOT written, so it returns false (the caller turns that into an error /
            // an unsupportedProperties entry) — it used to be caught, logged and reported as
            // applied, which is the same hollow success as an unknown key.
            switch (prop.ToLowerInvariant())
            {
                case "title":
                    try { dq.Title = value; }
                    catch { Console.Error.WriteLine($"[WriteService] AxQuery.Title not available on this subclass"); return false; }
                    break;
                case "description":
                    try { dq.Description = value; }
                    catch { Console.Error.WriteLine($"[WriteService] AxQuery.Description not available on this subclass"); return false; }
                    break;
                case "allowcrosscompany":
                    try { dq.AllowCrossCompany = ParseNoYes(value); }
                    catch { Console.Error.WriteLine($"[WriteService] AxQuery.AllowCrossCompany not available"); return false; }
                    break;
                default:
                    Console.Error.WriteLine($"[WriteService] Unknown AxQuery property: {prop}");
                    return false;
            }
            return true;
        }

        /// <summary>
        /// AxDataEntityView property setter. AllowRowVersionChangeTracking is
        /// dual-write's change-tracking switch and is also required on every
        /// source table.
        /// </summary>
        private bool SetAxDataEntityViewProperty(AxDataEntityView e, string prop, string value)
        {
            switch (prop.ToLowerInvariant())
            {
                case "label": e.Label = value; break;
                case "developerdocumentation": e.DeveloperDocumentation = value; break;
                case "primarykey": e.PrimaryKey = value; break;
                case "publicentityname": e.PublicEntityName = value; break;
                case "publiccollectionname": e.PublicCollectionName = value; break;
                case "datamanagementstagingtable": e.DataManagementStagingTable = value; break;
                case "ispublic": e.IsPublic = ParseNoYes(value); break;
                case "datamanagementenabled": e.DataManagementEnabled = ParseNoYes(value); break;
                case "allowrowversionchangetracking": e.AllowRowVersionChangeTracking = ParseNoYes(value); break;
                case "allowretention": e.AllowRetention = ParseNoYes(value); break;
                case "entitycategory":
                    if (!Enum.TryParse<Microsoft.Dynamics.AX.Metadata.Core.MetaModel.EntityCategory>(value, true, out var ec))
                        throw new ArgumentException(
                            $"'{value}' is not a valid EntityCategory. Valid values: " +
                            string.Join(", ", Enum.GetNames(typeof(Microsoft.Dynamics.AX.Metadata.Core.MetaModel.EntityCategory))) + ".");
                    e.EntityCategory = ec;
                    break;
                default:
                    Console.Error.WriteLine($"[WriteService] Unknown AxDataEntityView property: {prop}");
                    return false;
            }
            return true;
        }

        private bool SetAxViewProperty(AxView v, string prop, string value)
        {
            switch (prop.ToLowerInvariant())
            {
                case "label": v.Label = value; break;
                case "developerdocumentation": v.DeveloperDocumentation = value; break;
                default:
                    Console.Error.WriteLine($"[WriteService] Unknown AxView property: {prop}");
                    return false;
            }
            return true;
        }

        /// <summary>
        /// Shared property setter for all three menu item types (Action, Display, Output).
        /// AxMenuItemAction/Display/Output all inherit from AxMenuItem which shares these properties.
        /// </summary>
        private bool SetAxMenuItemProperty(dynamic mi, string prop, string value)
        {
            switch (prop.ToLowerInvariant())
            {
                case "label": mi.Label = value; break;
                case "helptext": mi.HelpText = value; break;
                case "object": mi.Object = value; break;
                // A value the enum does not know is rejected with the legal ones, the way
                // TableType / EntityCategory already are. Swallowing the failed parse left the
                // property at its metamodel default and reported success, so a menu item asked
                // for ObjectType=Form silently shipped pointing at nothing — and the caller
                // only found out when the menu item did not open.
                case "objecttype":
                    if (!Enum.TryParse<Microsoft.Dynamics.AX.Metadata.Core.MetaModel.MenuItemObjectType>(value, true, out var ot))
                        throw new ArgumentException(
                            $"'{value}' is not a valid menu item ObjectType. Valid values: " +
                            string.Join(", ", Enum.GetNames(typeof(Microsoft.Dynamics.AX.Metadata.Core.MetaModel.MenuItemObjectType))) + ".");
                    mi.ObjectType = ot;
                    break;
                case "openmode":
                    if (!Enum.TryParse<Microsoft.Dynamics.AX.Metadata.Core.MetaModel.OpenMode>(value, true, out var om))
                        throw new ArgumentException(
                            $"'{value}' is not a valid menu item OpenMode. Valid values: " +
                            string.Join(", ", Enum.GetNames(typeof(Microsoft.Dynamics.AX.Metadata.Core.MetaModel.OpenMode))) + ".");
                    mi.OpenMode = om;
                    break;
                case "normalimage": mi.NormalImage = value; break;
                case "imagelocation":
                    // ImageLocation enum type varies across D365FO versions — skip for safety
                    Console.Error.WriteLine($"[WriteService] ImageLocation not directly supported — use modify-property after creation");
                    return false;
                case "configurationkey": mi.ConfigurationKey = value; break;
                case "countryregioncodes": mi.CountryRegionCodes = value; break;
                case "maintainuserauthorization":
                    mi.MaintainUserAuthorization = ParseNoYes(value);
                    break;
                default:
                    Console.Error.WriteLine($"[WriteService] Unknown AxMenuItem property: {prop}");
                    return false;
            }
            return true;
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

        /// <summary>
        /// Tries to update an existing method's source in place, preserving its position in the collection.
        /// Checks top-level Methods, form SourceCode.Methods, and form SourceCode.DataControls.
        /// Returns true if the method was found and updated.
        /// </summary>
        private bool TryUpdateMethodSourceInPlace(object axObject, string methodName, string newSource)
        {
            // Try top-level Methods first (AxClass, AxTable, AxTableExtension, etc.)
            if (TryUpdateSourceInCollection(axObject, "Methods", methodName, newSource)) return true;

            string? controlNameFilter = null;
            string effectiveMethodName = methodName;
            if (!string.IsNullOrWhiteSpace(methodName) && methodName.Contains('.'))
            {
                var dotIdx = methodName.IndexOf('.');
                controlNameFilter = methodName.Substring(0, dotIdx);
                effectiveMethodName = methodName.Substring(dotIdx + 1);
            }

            // For forms: SourceCode.Methods (form-level methods like init, run)
            try
            {
                dynamic dyn = axObject;
                dynamic sourceCode = dyn.SourceCode;
                if (sourceCode != null)
                {
                    if (TryUpdateSourceInCollection(sourceCode, "Methods", methodName, newSource)) return true;

                    if (controlNameFilter != null)
                    {
                        var combinedName = $"{controlNameFilter}_{effectiveMethodName}";
                        if (TryUpdateSourceInCollection(sourceCode, "Methods", combinedName, newSource)) return true;
                    }
                }
            }
            catch { }

            // For forms: SourceCode.DataControls (control override methods)
            try
            {
                dynamic dyn = axObject;
                dynamic sourceCode = dyn.SourceCode;
                if (sourceCode != null && TryUpdateSourceInFormDataControls(sourceCode, controlNameFilter, effectiveMethodName, methodName, newSource)) return true;
            }
            catch { }

            return false;
        }

        private bool TryUpdateSourceInFormDataControls(dynamic sourceCode, string? controlNameFilter, string effectiveMethodName, string originalMethodName, string newSource)
        {
            try
            {
                foreach (dynamic ctrl in sourceCode.DataControls)
                {
                    string ctrlName = (string)ctrl.Name;
                    bool controlMatches = controlNameFilter == null ||
                        string.Equals(ctrlName, controlNameFilter, StringComparison.OrdinalIgnoreCase);

                    if (!controlMatches) continue;

                    try
                    {
                        foreach (dynamic m in ctrl.Methods)
                        {
                            string mName = (string)m.Name;
                            if (string.Equals(mName, effectiveMethodName, StringComparison.OrdinalIgnoreCase) ||
                                string.Equals(mName, originalMethodName, StringComparison.OrdinalIgnoreCase))
                            {
                                m.Source = newSource;
                                return true;
                            }
                        }
                    }
                    catch { }

                    try
                    {
                        string? directSrc = (string?)ctrl.Source;
                        if (directSrc != null && controlNameFilter != null)
                        {
                            ctrl.Source = newSource;
                            return true;
                        }
                    }
                    catch { }
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WriteService] TryUpdateSourceInFormDataControls({originalMethodName}) failed: {ex.Message}");
            }

            return false;
        }

        /// <summary>
        /// Tries to update the Source property of a method in a named collection.
        /// Returns true if found and updated.
        /// </summary>
        private bool TryUpdateSourceInCollection(object parentObj, string collectionName, string methodName, string newSource)
        {
            try
            {
                var prop = parentObj.GetType().GetProperty(collectionName);
                if (prop == null) return false;
                dynamic collection = prop.GetValue(parentObj);
                if (collection == null) return false;

                foreach (dynamic m in collection)
                {
                    string mName = (string)m.Name;
                    if (string.Equals(mName, methodName, StringComparison.OrdinalIgnoreCase))
                    {
                        m.Source = newSource;
                        return true;
                    }
                }
                return false;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WriteService] TryUpdateSourceInCollection({collectionName}, {methodName}) failed: {ex.Message}");
                return false;
            }
        }

        /// <summary>Sets a property on an existing table field.</summary>
        /// <summary>Table-field properties SetTableFieldProperty knows how to write.</summary>
        private static readonly string[] SupportedTableFieldProperties =
            { "label", "helpText", "mandatory", "allowEdit", "extendedDataType", "stringSize", "enumType" };

        /// <summary>
        /// Applies one field property. Returns false when the key is unknown, or when it
        /// is known but does not apply to THIS field type (stringSize on an enum field) —
        /// the caller turns "nothing applied" into an error instead of a hollow success.
        /// </summary>
        private bool SetTableFieldProperty(AxTableField field, string prop, string value)
        {
            switch (prop.ToLowerInvariant())
            {
                case "label": field.Label = value; return true;
                case "helptext": field.HelpText = value; return true;
                case "mandatory":
                    field.Mandatory = ParseNoYes(value);
                    return true;
                case "allowedit":
                    field.AllowEdit = ParseNoYes(value);
                    return true;
                case "extendeddatatype":
                case "edt":
                    field.ExtendedDataType = value;
                    return true;
                case "stringsize":
                    if (field is AxTableFieldString sf && int.TryParse(value, out var ss)) { sf.StringSize = ss; return true; }
                    return false;
                case "enumtype":
                    if (field is AxTableFieldEnum ef) { ef.EnumType = value; return true; }
                    return false;
                default:
                    Console.Error.WriteLine($"[WriteService] Unknown table field property: {prop}");
                    return false;
            }
        }

        /// <summary>
        /// Turns a property bag that changed nothing into an error.
        ///
        /// Every modify-* op here read its properties, applied whatever it recognised,
        /// called Update() and returned success — so a caller who sent the parameters in
        /// the wrong shape (flat instead of nested under `properties`), or a key this
        /// build does not support, got "✅ modified" over a byte-identical file. The
        /// modify surface must not report a write it did not make.
        /// </summary>
        private static void RequireSomethingApplied(
            string operation, string objectName, string targetName,
            Dictionary<string, string>? properties, List<string> applied, IEnumerable<string> supported)
        {
            if (applied.Count > 0) return;
            if (properties == null || properties.Count == 0)
                throw new ArgumentException(
                    $"{operation} on '{objectName}.{targetName}' was given no properties, so it would " +
                    $"change nothing. Pass them under `properties`, e.g. " +
                    $"properties: {{ \"{supported.First()}\": \"…\" }}. Supported: {string.Join(", ", supported)}.");
            throw new ArgumentException(
                $"{operation} on '{objectName}.{targetName}' changed nothing: none of " +
                $"[{string.Join(", ", properties.Keys)}] could be applied. Supported: {string.Join(", ", supported)}.");
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
            string? dataSource, string? dataField, string? label, out List<string> unsupportedProperties)
        {
            // D365FO form control classes follow the naming convention AxForm{Type}Control
            // (e.g. AxFormStringControl, AxFormRealControl, AxFormGridControl) — verified
            // against live IMetadataProvider reads of real forms (get_object_info) and
            // against the already-correct CONTROL_TYPE_TO_FORM_CONTROL map used by the
            // TS-side form-extension XML fallback (modifyD365File.ts). The PREVIOUS
            // "AxFormControl{Type}" pattern below does not exist for ANY type — every
            // call fell through to the dictionary fallback, whose values used the exact
            // same backwards pattern (e.g. "AxFormControlString"), so assembly.GetType()
            // returned null there too and add-control failed for every control type,
            // every time, regardless of the field's data type. This was the (until now
            // unexplained) "add-control is completely non-functional" defect documented
            // across multiple eval runs (docs/USAGE_EXAMPLES.md).
            var assembly = typeof(AxClass).Assembly;
            string typeName = $"Microsoft.Dynamics.AX.Metadata.MetaModel.AxForm{controlType}Control";
            var ctrlType = assembly.GetType(typeName);

            // Fallback: try common type-keyword aliases (case-insensitive; matches the
            // keywords resolveEdtBaseType/heuristicEdtBaseType return on the TS side).
            if (ctrlType == null)
            {
                var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                {
                    ["String"] = "AxFormStringControl",
                    ["Integer"] = "AxFormIntegerControl",
                    ["Int"] = "AxFormIntegerControl",
                    ["Real"] = "AxFormRealControl",
                    ["Date"] = "AxFormDateControl",
                    ["DateTime"] = "AxFormDateTimeControl",
                    ["UtcDateTime"] = "AxFormDateTimeControl",
                    ["Time"] = "AxFormTimeControl",
                    ["Int64"] = "AxFormInt64Control",
                    ["Guid"] = "AxFormGuidControl",
                    ["Enum"] = "AxFormComboBoxControl",
                    ["CheckBox"] = "AxFormCheckBoxControl",
                    ["ComboBox"] = "AxFormComboBoxControl",
                    ["Group"] = "AxFormGroupControl",
                    ["Button"] = "AxFormButtonControl",
                    ["CommandButton"] = "AxFormCommandButtonControl",
                    ["Grid"] = "AxFormGridControl",
                    ["Tab"] = "AxFormTabControl",
                    ["TabPage"] = "AxFormTabPageControl",
                    ["Image"] = "AxFormImageControl",
                    ["ActionPane"] = "AxFormActionPaneControl",
                    ["ActionPaneTab"] = "AxFormActionPaneTabControl",
                    ["ButtonGroup"] = "AxFormButtonGroupControl",
                };
                if (map.TryGetValue(controlType, out var mapped))
                    ctrlType = assembly.GetType($"Microsoft.Dynamics.AX.Metadata.MetaModel.{mapped}");
            }

            if (ctrlType == null)
                throw new ArgumentException($"Unknown form control type: '{controlType}' — no matching AxFormControl type found");

            dynamic ctrl = Activator.CreateInstance(ctrlType)!;
            ctrl.Name = controlName;

            // Not every AxForm*Control carries these: a Group, Tab or CommandButton has no
            // DataSource/DataField, and the assignment throws. Swallowing that produced the
            // worst possible outcome — an UNBOUND control reported as added and bound, which
            // renders as an empty control on the form and reads as a working one in the tool
            // output. Report what did not stick; the caller decides whether that is fatal.
            unsupportedProperties = new List<string>();
            if (!string.IsNullOrEmpty(dataSource))
            {
                try { ctrl.DataSource = dataSource; }
                catch { unsupportedProperties.Add("dataSource"); }
            }
            if (!string.IsNullOrEmpty(dataField))
            {
                try { ctrl.DataField = dataField; }
                catch { unsupportedProperties.Add("dataField"); }
            }
            if (!string.IsNullOrEmpty(label))
            {
                try { ctrl.Label = label; }
                catch { unsupportedProperties.Add("label"); }
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
                            // (for cases where control name IS the method name, e.g. flat override list).
                            // Only safe when we can tie this item to the request: either the caller named
                            // this control ("PostButton.clicked"), or the item's own name IS the method.
                            // Without that check an unqualified methodName ("clicked") would match every
                            // control in the form and rewrite the first unrelated one that happens to
                            // contain oldCode, while the caller is told 'clicked' was edited.
                            bool itemIsRequestedMember = controlNameFilter != null
                                || effectiveMethodName == null
                                || string.Equals(ctrlName, effectiveMethodName, StringComparison.OrdinalIgnoreCase);

                            if (!replaced && itemIsRequestedMember)
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

                // Absolute last resort: scan the SourceCode sub-collections for the requested member,
                // for edge cases where the SDK stores it under an unexpected CONTAINER. The method
                // scope travels with it — a fallback that ignored methodName silently rewrote a
                // DIFFERENT method whenever the target one did not contain oldCode, and still
                // reported success, so the caller believed its edit had landed.
                if (!replaced)
                {
                    replaced = ReplaceCodeInXmlFallback(dyn, methodName, controlNameFilter, effectiveMethodName, oldCode, newCode);
                }

                return replaced;
            }
            catch (Exception ex)
            {
                // A genuine failure (SDK binder fault, provider I/O) is NOT "the snippet is absent".
                // Returning false here made every caller report "oldCode not found", which sends the
                // calling agent off retrying different snippets against a healthy method instead of
                // surfacing the real fault. Surface it, keeping the original as InnerException.
                Console.Error.WriteLine($"[WriteService] ReplaceInMethods failed: {ex.Message}");
                throw new InvalidOperationException(
                    $"replace-code failed while editing {(methodName != null ? $"method '{methodName}'" : "object source")}: {ex.Message}", ex);
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
        /// Absolute last-resort fallback: enumerate the iterable collections exposed by SourceCode
        /// (Methods, DataSources, DataControls, Members) and any nested items looking for Source
        /// properties that contain oldCode. Used when structured access fails.
        /// For DataControls, also iterates into each control's Methods sub-collection.
        ///
        /// The fallback widens the CONTAINER it looks in, never the member it edits: when the caller
        /// named a method, only members carrying that name are eligible. An unnamed member cannot be
        /// proven to be the target, so it is skipped rather than edited on a text match.
        /// </summary>
        private bool ReplaceCodeInXmlFallback(dynamic axObject, string? methodName, string? controlNameFilter,
            string? effectiveMethodName, string oldCode, string newCode)
        {
            bool replaced = false;

            // Accepts the same name spellings the structured passes accept for one member:
            // the bare method name, the raw "Control.method" the caller sent, and the
            // "Control_method" flattening some form shapes use.
            bool IsRequestedMember(string? memberName)
            {
                if (effectiveMethodName == null) return true;   // caller scoped to the whole object
                if (memberName == null) return false;
                return string.Equals(memberName, effectiveMethodName, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(memberName, methodName, StringComparison.OrdinalIgnoreCase)
                    || (controlNameFilter != null && string.Equals(memberName,
                            $"{controlNameFilter}_{effectiveMethodName}", StringComparison.OrdinalIgnoreCase));
            }

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
                                string? itemName = null;
                                try { itemName = (string?)item.Name; } catch { }
                                if (!IsRequestedMember(itemName)) continue;

                                string? src = null;
                                try { src = (string?)item.Source; } catch { }
                                if (src != null && src.Contains(oldCode))
                                {
                                    item.Source = src.Replace(oldCode, newCode);
                                    replaced = true;
                                    Console.Error.WriteLine($"[WriteService] ReplaceCodeInXmlFallback: replaced in SourceCode.{colName} item '{itemName ?? "?"}'");
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

                                    // A control-scoped request ("PostButton.clicked") stays inside its
                                    // control; reaching into a sibling control would edit an override
                                    // the caller never named.
                                    if (controlNameFilter != null &&
                                        !string.Equals(ctrlName, controlNameFilter, StringComparison.OrdinalIgnoreCase))
                                        continue;

                                    // Try methods inside control
                                    try
                                    {
                                        foreach (dynamic m in ctrl.Methods)
                                        {
                                            try
                                            {
                                                string? mName = null;
                                                try { mName = (string?)m.Name; } catch { }
                                                if (!IsRequestedMember(mName)) continue;

                                                string? src = (string?)m.Source;
                                                if (src != null && src.Contains(oldCode))
                                                {
                                                    m.Source = src.Replace(oldCode, newCode);
                                                    replaced = true;
                                                    Console.Error.WriteLine($"[WriteService] ReplaceCodeInXmlFallback: replaced in DataControls.{ctrlName}.{mName ?? "?"}");
                                                }
                                            }
                                            catch { }
                                        }
                                    }
                                    catch { }

                                    // Also try direct Source on control object (flat override lists).
                                    // Eligible only when the caller named this control, or the control's
                                    // own name is the method name — otherwise this item is some other
                                    // control's code and must not absorb the edit.
                                    if (controlNameFilter != null || IsRequestedMember(ctrlName))
                                    {
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
                // Swallowing this used to leave the caller with "oldCode not found" even though the
                // scan never completed — and possibly with a partial edit already applied. Let it out
                // so ReplaceInMethods reports a real error and no Update is attempted.
                Console.Error.WriteLine($"[WriteService] ReplaceCodeInXmlFallback failed: {ex.Message}");
                throw;
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
                        return new ModelSaveInfo { Id = mi.Id, Layer = mi.Layer, Name = mi.Name, SequenceId = mi.SequenceId };
                    }
                }
            }
            catch { /* GetModelInfo not found on this interface — continue to fallback */ }

            // Strategy 2: try all concrete provider properties that have GetModelInfo
            ModelInfo? foundMi = TryGetModelInfoFromProviders(objectName);
            if (foundMi != null)
            {
                return new ModelSaveInfo { Id = foundMi.Id, Layer = foundMi.Layer, Name = foundMi.Name, SequenceId = foundMi.SequenceId };
            }

            // Strategy 3: infer model from on-disk file path
            //   Files live at {packagesPath}/{ModelName}/{ModelName}/Ax{Type}/{Name}.xml
            //   We scan common AOT folders for the object name. A union scan, not a
            //   type mapping: every folder is tried, so AxClass already covers class
            //   extensions ([ExtensionOf(...)] AxClass files) and an AxClassExtension
            //   entry would only ever be a probe that cannot match — no package has
            //   that folder (#693).
            string[] aotFolders = { "AxClass", "AxTable", "AxForm", "AxEnum", "AxEdt",
                                    "AxQuery", "AxView", "AxDataEntityView", "AxReport",
                                    "AxMenu", "AxMenuItemDisplay", "AxMenuItemAction", "AxMenuItemOutput",
                                    "AxSecurityPrivilege", "AxSecurityDuty", "AxSecurityRole",
                                    "AxTableExtension", "AxFormExtension", "AxEnumExtension",
                                    "AxEdtExtension", "AxDataEntityViewExtension" };
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

        [System.Text.Json.Serialization.JsonPropertyName("type")]
        public string? FieldType { get; set; }

        /// <summary>
        /// `fieldType` is how the SAME thing is spelled by the add-field RPCs (single
        /// and batch) and by the tool's own fields[] documentation. Only `type` was
        /// bound here, and System.Text.Json drops an unknown key silently, so a caller
        /// who carried the add-field spelling into a create got every field as a bare
        /// AxTableFieldString. Both spellings now land on one property; `type` wins.
        /// </summary>
        [System.Text.Json.Serialization.JsonPropertyName("fieldType")]
        public string? FieldTypeAlias
        {
            get => null;
            set { if (string.IsNullOrEmpty(FieldType)) FieldType = value; }
        }

        [System.Text.Json.Serialization.JsonPropertyName("edt")]
        public string? Edt { get; set; }

        /// <summary>Same aliasing as fieldType: `extendedDataType` is the XML element name
        /// and the spelling half the callers reach for. `edt` wins.</summary>
        [System.Text.Json.Serialization.JsonPropertyName("extendedDataType")]
        public string? EdtAlias
        {
            get => null;
            set { if (string.IsNullOrEmpty(Edt)) Edt = value; }
        }

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

    /// <summary>
    /// One field pairing of an AxTableMapping: mapField is the field on the MAP,
    /// mapFieldTo the field on the table being mapped.
    /// </summary>
    public class WriteMappingConnection
    {
        [System.Text.Json.Serialization.JsonPropertyName("mapField")]
        public string? MapField { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("mapFieldTo")]
        public string? MapFieldTo { get; set; }
    }

    public class WriteEnumValueParam
    {
        [System.Text.Json.Serialization.JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [System.Text.Json.Serialization.JsonPropertyName("value")]
        public int Value { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("label")]
        public string? Label { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("countryRegionCodes")]
        public string? CountryRegionCodes { get; set; }
    }
}
