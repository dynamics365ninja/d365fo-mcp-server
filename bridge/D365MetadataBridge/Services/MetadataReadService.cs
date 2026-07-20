using System;
using System.Collections.Generic;
using System.Linq;
using D365MetadataBridge.Models;
using Microsoft.Dynamics.AX.Metadata.MetaModel;
using Microsoft.Dynamics.AX.Metadata.Providers;
using Microsoft.Dynamics.AX.Metadata.Storage;

namespace D365MetadataBridge.Services
{
    /// <summary>
    /// Reads D365FO metadata using Microsoft's official IMetadataProvider API.
    /// Uses CreateDiskProvider (standalone mode, no VS/instrumentation dependency).
    /// </summary>
    public class MetadataReadService
    {
        private IMetadataProvider _provider;
        private readonly string _packagesPath;
        private readonly string? _referencePackagesPath;
        private IMetadataProvider? _referenceProvider;

        /// <summary>
        /// Exposes the current provider for MetadataWriteService initialization.
        /// </summary>
        public IMetadataProvider Provider => _provider;

        /// <summary>
        /// Optional callback invoked after RefreshProvider() so the write service can stay in sync.
        /// </summary>
        public Action<IMetadataProvider>? OnProviderRefreshed { get; set; }

        /// <summary>
        /// Initializes the metadata read service.
        /// </summary>
        /// <param name="packagesPath">Primary packages path (custom packages in UDE, or standard PackagesLocalDirectory).</param>
        /// <param name="referencePackagesPath">
        /// Optional secondary packages path (UDE: Microsoft FrameworkDirectory).
        /// When provided, all read operations fall back to this provider if the primary
        /// does not contain the requested object — enabling resolution of both custom
        /// and Microsoft-shipped metadata in UDE environments.
        /// </param>
        public MetadataReadService(string packagesPath, string? referencePackagesPath = null)
        {
            _packagesPath = packagesPath;
            _referencePackagesPath = referencePackagesPath;
            // Use DiskProvider (standalone mode) — avoids .NET Framework EventDescriptor dependency
            var factory = new MetadataProviderFactory();
            _provider = CreatePrimaryProvider(factory, packagesPath, referencePackagesPath);
            Console.Error.WriteLine($"[MetadataService] Initialized via DiskProvider: {packagesPath}");

            if (referencePackagesPath != null)
            {
                try
                {
                    _referenceProvider = factory.CreateDiskProvider(referencePackagesPath);
                    Console.Error.WriteLine($"[MetadataService] Reference DiskProvider: {referencePackagesPath}");
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[WARN] Failed to initialize reference DiskProvider at '{referencePackagesPath}': {ex.Message}");
                }
            }
        }

        /// <summary>
        /// Builds the primary DiskProvider. When a reference (standard/Microsoft) packages
        /// path is configured, the provider spans BOTH roots so that WRITE operations can
        /// resolve a STANDARD base object — e.g. creating an extension of a standard enum.
        /// A single-root provider over only the custom path cannot, which made
        /// createObject(enum-extension of a standard base) throw "The given key was not
        /// present in the dictionary".
        ///
        /// Defensive: if the multi-root configuration is unavailable on this platform the
        /// method falls back to the single-path provider, so the working read path is never
        /// regressed (worst case = prior behaviour).
        /// </summary>
        private static IMetadataProvider CreatePrimaryProvider(MetadataProviderFactory factory, string primaryPath, string? referencePath)
        {
            if (!string.IsNullOrEmpty(referencePath) && System.IO.Directory.Exists(referencePath))
            {
                try
                {
                    var config = new Microsoft.Dynamics.AX.Metadata.Storage.DiskProvider.DiskProviderConfiguration
                    {
                        MetadataPath = primaryPath,
                        IncludeStatic = true,
                    };
                    config.AddMetadataPath(referencePath!);
                    var combined = factory.CreateDiskProvider(config);
                    Console.Error.WriteLine($"[MetadataService] DiskProvider spans 2 roots (writes can resolve standard bases): {primaryPath} + {referencePath}");
                    return combined;
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[WARN] Combined DiskProvider failed ({ex.Message}) — using single-path provider: {primaryPath}");
                }
            }
            return factory.CreateDiskProvider(primaryPath);
        }

        /// <summary>
        /// Returns the first IMetadataProvider for which <paramref name="exists"/> returns true.
        /// Checks the primary provider first, then the reference provider (UDE fallback).
        /// Returns null only when neither provider contains the requested object.
        /// </summary>
        private IMetadataProvider? PickProvider(Func<IMetadataProvider, bool> exists)
        {
            try { if (exists(_provider)) return _provider; } catch { }
            if (_referenceProvider != null)
            {
                try { if (exists(_referenceProvider)) return _referenceProvider; } catch { }
            }
            return null;
        }

        // ========================
        // WRITE-SUPPORT: Validate / Resolve / Refresh
        // ========================

        /// <summary>
        /// Re-creates the DiskProvider so newly written files are picked up.
        /// Notifies the write service via OnProviderRefreshed callback.
        /// </summary>
        public object RefreshProvider()
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var factory = new MetadataProviderFactory();
            _provider = CreatePrimaryProvider(factory, _packagesPath, _referencePackagesPath);
            OnProviderRefreshed?.Invoke(_provider);
            sw.Stop();
            Console.Error.WriteLine($"[MetadataService] Provider refreshed in {sw.ElapsedMilliseconds}ms");
            return new { refreshed = true, elapsedMs = sw.ElapsedMilliseconds };
        }

        /// <summary>
        /// Asks IMetadataProvider to read back an object that was just written to disk.
        /// Returns field/method counts and a success flag — proves the XML is well-formed
        /// and the metadata API can consume it.
        /// </summary>
        public object? ValidateObject(string objectType, string objectName)
        {
            try
            {
                switch (objectType.ToLowerInvariant())
                {
                    case "table":
                    case "table-extension":
                        if (!_provider.Tables.Exists(objectName)) return new { valid = false, reason = $"Table '{objectName}' not found by IMetadataProvider after refresh" };
                        var t = _provider.Tables.Read(objectName);
                        return new { valid = true, objectType, objectName, fieldCount = t?.Fields?.Count ?? 0, methodCount = t?.Methods?.Count ?? 0, indexCount = t?.Indexes?.Count ?? 0 };

                    case "class":
                    case "class-extension":
                        if (!_provider.Classes.Exists(objectName)) return new { valid = false, reason = $"Class '{objectName}' not found by IMetadataProvider after refresh" };
                        var c = _provider.Classes.Read(objectName);
                        return new { valid = true, objectType, objectName, fieldCount = 0, methodCount = c?.Methods?.Count ?? 0, indexCount = 0 };

                    case "enum":
                        if (!_provider.Enums.Exists(objectName)) return new { valid = false, reason = $"Enum '{objectName}' not found by IMetadataProvider after refresh" };
                        var en = _provider.Enums.Read(objectName);
                        int valueCount = 0;
                        try { dynamic den = en; if (den?.Values != null) foreach (var _ in den.Values) valueCount++; } catch { }
                        return new { valid = true, objectType, objectName, fieldCount = 0, methodCount = 0, valueCount, indexCount = 0 };

                    case "edt":
                        if (!_provider.Edts.Exists(objectName)) return new { valid = false, reason = $"EDT '{objectName}' not found by IMetadataProvider after refresh" };
                        return new { valid = true, objectType, objectName };

                    case "form":
                    case "form-extension":
                        if (!_provider.Forms.Exists(objectName)) return new { valid = false, reason = $"Form '{objectName}' not found by IMetadataProvider after refresh" };
                        return new { valid = true, objectType, objectName };

                    case "query":
                        if (!_provider.Queries.Exists(objectName)) return new { valid = false, reason = $"Query '{objectName}' not found by IMetadataProvider after refresh" };
                        return new { valid = true, objectType, objectName };

                    case "view":
                        if (!_provider.Views.Exists(objectName)) return new { valid = false, reason = $"View '{objectName}' not found by IMetadataProvider after refresh" };
                        return new { valid = true, objectType, objectName };

                    case "report":
                        if (!_provider.Reports.Exists(objectName)) return new { valid = false, reason = $"Report '{objectName}' not found by IMetadataProvider after refresh" };
                        return new { valid = true, objectType, objectName };

                    case "menu":
                        if (!_provider.Menus.Exists(objectName)) return new { valid = false, reason = $"Menu '{objectName}' not found by IMetadataProvider after refresh" };
                        return new { valid = true, objectType, objectName };

                    case "menu-item-display":
                        if (!_provider.MenuItemDisplays.Exists(objectName)) return new { valid = false, reason = $"MenuItemDisplay '{objectName}' not found by IMetadataProvider after refresh" };
                        return new { valid = true, objectType, objectName };

                    case "menu-item-action":
                        if (!_provider.MenuItemActions.Exists(objectName)) return new { valid = false, reason = $"MenuItemAction '{objectName}' not found by IMetadataProvider after refresh" };
                        return new { valid = true, objectType, objectName };

                    case "menu-item-output":
                        if (!_provider.MenuItemOutputs.Exists(objectName)) return new { valid = false, reason = $"MenuItemOutput '{objectName}' not found by IMetadataProvider after refresh" };
                        return new { valid = true, objectType, objectName };

                    case "security-privilege":
                        if (!_provider.SecurityPrivileges.Exists(objectName)) return new { valid = false, reason = $"SecurityPrivilege '{objectName}' not found by IMetadataProvider after refresh" };
                        return new { valid = true, objectType, objectName };

                    case "security-duty":
                        if (!_provider.SecurityDuties.Exists(objectName)) return new { valid = false, reason = $"SecurityDuty '{objectName}' not found by IMetadataProvider after refresh" };
                        return new { valid = true, objectType, objectName };

                    case "security-role":
                        if (!_provider.SecurityRoles.Exists(objectName)) return new { valid = false, reason = $"SecurityRole '{objectName}' not found by IMetadataProvider after refresh" };
                        return new { valid = true, objectType, objectName };

                    default:
                        // Types the bridge can't read back yet (label, resource, tile, kpi, …):
                        // not an error — the file was already written. Caller logs this at debug.
                        return new { valid = false, reason = $"validation-unsupported: {objectType}" };
                }
            }
            catch (Exception ex)
            {
                return new { valid = false, reason = $"IMetadataProvider threw an exception reading {objectType}/{objectName}: {ex.Message}" };
            }
        }

        /// <summary>
        /// Uses IMetadataProvider to check if a given object name exists, and returns
        /// the model name it belongs to. Useful for modify_d365fo_file to locate objects
        /// without depending on the SQLite index.
        /// </summary>
        public object? ResolveObjectInfo(string objectType, string objectName)
        {
            try
            {
                switch (objectType.ToLowerInvariant())
                {
                    case "table":
                    case "table-extension":
                    {
                        var prov = PickProvider(p => p.Tables.Exists(objectName));
                        if (prov == null) return null;
                        string? model = null;
                        try { var mi = prov.Tables.GetModelInfo(objectName); if (mi?.Count > 0) model = mi.First().Name; } catch { }
                        return new { exists = true, objectType, objectName, model };
                    }
                    case "class":
                    case "class-extension":
                    {
                        var prov = PickProvider(p => p.Classes.Exists(objectName));
                        if (prov == null) return null;
                        string? model = null;
                        try { var mi = prov.Classes.GetModelInfo(objectName); if (mi?.Count > 0) model = mi.First().Name; } catch { }
                        return new { exists = true, objectType, objectName, model };
                    }
                    case "enum":
                    {
                        var prov = PickProvider(p => p.Enums.Exists(objectName));
                        if (prov == null) return null;
                        string? model = null;
                        try { var mi = prov.Enums.GetModelInfo(objectName); if (mi?.Count > 0) model = mi.First().Name; } catch { }
                        return new { exists = true, objectType, objectName, model };
                    }
                    case "edt":
                    {
                        var prov = PickProvider(p => p.Edts.Exists(objectName));
                        if (prov == null) return null;
                        string? model = null;
                        try { var mi = prov.Edts.GetModelInfo(objectName); if (mi?.Count > 0) model = mi.First().Name; } catch { }
                        return new { exists = true, objectType, objectName, model };
                    }
                    case "form":
                    case "form-extension":
                    {
                        var prov = PickProvider(p => p.Forms.Exists(objectName));
                        if (prov == null) return null;
                        string? model = null;
                        try { var mi = prov.Forms.GetModelInfo(objectName); if (mi?.Count > 0) model = mi.First().Name; } catch { }
                        return new { exists = true, objectType, objectName, model };
                    }
                    case "query":
                    {
                        var prov = PickProvider(p => p.Queries.Exists(objectName));
                        if (prov == null) return null;
                        string? model = null;
                        try { var mi = prov.Queries.GetModelInfo(objectName); if (mi?.Count > 0) model = mi.First().Name; } catch { }
                        return new { exists = true, objectType, objectName, model };
                    }
                    case "view":
                    {
                        var prov = PickProvider(p => p.Views.Exists(objectName));
                        if (prov == null) return null;
                        string? model = null;
                        try { var mi = prov.Views.GetModelInfo(objectName); if (mi?.Count > 0) model = mi.First().Name; } catch { }
                        return new { exists = true, objectType, objectName, model };
                    }
                    case "report":
                    {
                        var prov = PickProvider(p => p.Reports.Exists(objectName));
                        if (prov == null) return null;
                        string? model = null;
                        try { var mi = prov.Reports.GetModelInfo(objectName); if (mi?.Count > 0) model = mi.First().Name; } catch { }
                        return new { exists = true, objectType, objectName, model };
                    }
                    default:
                        return null;
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WARN] ResolveObjectInfo({objectType}, {objectName}): {ex.Message}");
                return null;
            }
        }

        // ========================
        // TABLE
        // ========================
        public TableInfoModel? ReadTable(string tableName)
        {
            var prov = PickProvider(p => p.Tables.Exists(tableName));
            if (prov == null) return null;
            var table = prov.Tables.Read(tableName);
            if (table == null) return null;

            var result = new TableInfoModel
            {
                Name = table.Name,
                Label = Safe(() => table.Label),
                DeveloperDocumentation = Safe(() => table.DeveloperDocumentation),
                TableGroup = Safe(() => table.TableGroup.ToString()),
                TableType = Safe(() => table.TableType.ToString()),
                CacheLookup = Safe(() => table.CacheLookup.ToString()),
                ClusteredIndex = Safe(() => table.ClusteredIndex),
                PrimaryIndex = Safe(() => table.PrimaryIndex),
                Extends = Safe(() => table.Extends),
                SaveDataPerCompany = Safe(() => table.SaveDataPerCompany.ToString()),
                SupportInheritance = Safe(() => table.SupportInheritance.ToString()),
                InstanceRelationType = Safe(() => table.InstanceRelationType),
            };

            try { var mi = prov.Tables.GetModelInfo(tableName); if (mi?.Count > 0) result.Model = mi.First().Name; } catch { }

            try { foreach (var f in table.Fields) result.Fields.Add(MapField(f)); } catch (Exception ex) { Warn("fields", tableName, ex); }
            try { foreach (var g in table.FieldGroups) { var gm = new FieldGroupModel { Name = g.Name, Label = Safe(() => g.Label) }; try { foreach (var f in g.Fields) gm.Fields.Add(Safe(() => f.DataField) ?? f.Name); } catch { } result.FieldGroups.Add(gm); } } catch (Exception ex) { Warn("fieldGroups", tableName, ex); }
            try { foreach (var i in table.Indexes) { var im = new IndexInfoModel { Name = i.Name, AllowDuplicates = IsYes(() => i.AllowDuplicates), AlternateKey = IsYes(() => i.AlternateKey) }; try { foreach (var f in i.Fields) im.Fields.Add(new IndexFieldModel { DataField = Safe(() => f.DataField) ?? f.Name, IncludedColumn = IsYes(() => f.IncludedColumn) }); } catch { } result.Indexes.Add(im); } } catch (Exception ex) { Warn("indexes", tableName, ex); }

            try
            {
                foreach (var r in table.Relations)
                {
                    var rm = new RelationInfoModel
                    {
                        Name = r.Name,
                        RelatedTable = Safe(() => r.RelatedTable) ?? "",
                        Cardinality = Safe(() => r.Cardinality.ToString()),
                        RelatedTableCardinality = Safe(() => r.RelatedTableCardinality.ToString()),
                    };
                    try
                    {
                        foreach (var c in r.Constraints)
                        {
                            var cm = new RelationConstraintModel();
                            if (c is AxTableRelationConstraintField fc) { cm.Field = fc.Field; cm.RelatedField = fc.RelatedField; }
                            else if (c is AxTableRelationConstraintFixed xc) { cm.Field = xc.Field; cm.Value = xc.Value.ToString(); }
                            rm.Constraints.Add(cm);
                        }
                    }
                    catch { }
                    result.Relations.Add(rm);
                }
            }
            catch (Exception ex) { Warn("relations", tableName, ex); }

            try { if (table.Methods != null) foreach (var m in table.Methods) result.Methods.Add(new MethodInfoModel { Name = m.Name, Source = Safe(() => m.Source) }); } catch (Exception ex) { Warn("methods", tableName, ex); }

            return result;
        }

        // ========================
        // CLASS
        // ========================
        public ClassInfoModel? ReadClass(string className)
        {
            var prov = PickProvider(p => p.Classes.Exists(className));
            if (prov == null) return null;
            var cls = prov.Classes.Read(className);
            if (cls == null) return null;

            var result = new ClassInfoModel
            {
                Name = cls.Name,
                IsAbstract = cls.IsAbstract,
                IsFinal = cls.IsFinal,
                IsStatic = cls.IsStatic,
                Extends = Safe(() => cls.Extends),
                Declaration = Safe(() => cls.Declaration),
            };

            try { var mi = prov.Classes.GetModelInfo(className); if (mi?.Count > 0) result.Model = mi.First().Name; } catch { }

            // Methods from cls.Methods (KeyedObjectCollection<AxMethod>) — the actual methods with source
            // Note: cls.SourceCode.Methods is AxMethodPropertyCollection (empty for disk reads) — DON'T use it
            try
            {
                if (cls.Methods != null)
                {
                    foreach (var method in cls.Methods)
                    {
                        result.Methods.Add(new MethodInfoModel
                        {
                            Name = method.Name,
                            Source = Safe(() => method.Source),
                        });
                    }
                }
            }
            catch (Exception ex) { Warn("methods", className, ex); }

            return result;
        }

        // ========================
        // METHOD SOURCE
        // ========================
        public MethodSourceModel GetMethodSource(string className, string methodName)
        {
            var result = new MethodSourceModel { ClassName = className, MethodName = methodName };

            // Try class first (checks primary then reference provider)
            var classProv = PickProvider(p => p.Classes.Exists(className));
            if (classProv != null)
            {
                var cls = classProv.Classes.Read(className);
                if (cls != null)
                {
                    if (string.Equals(methodName, "classDeclaration", StringComparison.OrdinalIgnoreCase))
                    {
                        result.Source = cls.Declaration;
                        result.Found = result.Source != null;
                        return result;
                    }

                    try
                    {
                        if (cls.Methods != null)
                        {
                            foreach (var method in cls.Methods)
                            {
                                if (string.Equals(method.Name, methodName, StringComparison.OrdinalIgnoreCase))
                                {
                                    result.MethodName = method.Name;
                                    result.Source = method.Source;
                                    result.Found = true;
                                    return result;
                                }
                            }
                        }
                    }
                    catch { }
                }
            }

            // Try table (checks primary then reference provider)
            var tableProv = PickProvider(p => p.Tables.Exists(className));
            if (tableProv != null)
            {
                var table = tableProv.Tables.Read(className);
                if (table?.Methods != null)
                {
                    try
                    {
                        foreach (var method in table.Methods)
                        {
                            if (string.Equals(method.Name, methodName, StringComparison.OrdinalIgnoreCase))
                            {
                                result.MethodName = method.Name;
                                result.Source = method.Source;
                                result.Found = true;
                                return result;
                            }
                        }
                    }
                    catch { }
                }
            }

            return result;
        }

        // ========================
        // ENUM
        // ========================
        public EnumInfoModel? ReadEnum(string enumName)
        {
            var prov = PickProvider(p => p.Enums.Exists(enumName));
            if (prov == null) return null;
            var e = prov.Enums.Read(enumName);
            if (e == null) return null;

            var result = new EnumInfoModel { Name = e.Name, Label = Safe(() => e.Label), HelpText = Safe(() => e.HelpText) };
            try { result.IsExtensible = e.IsExtensible; } catch { }
            try { var mi = prov.Enums.GetModelInfo(enumName); if (mi?.Count > 0) result.Model = mi.First().Name; } catch { }

            // UseEnumValue=No (the required setting for extensible enums, and the common
            // case for plain enums too) means values are position-based: the compiler
            // assigns 0,1,2,... by declaration order and the <Value> element is omitted
            // from the XML entirely. AxEnumValue.Value then deserializes to its int
            // default (0) for every member — that's not an exception, so a
            // SafeInt(..., idx) exception-based fallback never triggers, and every value
            // incorrectly reports as 0 instead of its real positional ordinal. Only trust
            // v.Value when UseEnumValue=Yes; otherwise use the declaration-order index,
            // which is what actually gets compiled.
            bool usesEnumValue = IsYes(() => ((dynamic)e).UseEnumValue);

            try
            {
                int idx = 0;
                foreach (var v in e.EnumValues)
                {
                    int value = usesEnumValue ? SafeInt(() => v.Value, idx) : idx;
                    result.Values.Add(new EnumValueModel { Name = v.Name, Value = value, Label = Safe(() => v.Label) });
                    idx++;
                }
            }
            catch (Exception ex) { Warn("values", enumName, ex); }

            return result;
        }

        // ========================
        // EDT
        // ========================
        public EdtInfoModel? ReadEdt(string edtName)
        {
            var prov = PickProvider(p => p.Edts.Exists(edtName));
            if (prov == null) return null;
            var edt = prov.Edts.Read(edtName);
            if (edt == null) return null;

            var result = new EdtInfoModel
            {
                Name = edt.Name,
                BaseType = edt.GetType().Name.Replace("AxEdt", ""),
                Extends = Safe(() => edt.Extends),
                Label = Safe(() => edt.Label),
                HelpText = Safe(() => edt.HelpText),
            };

            try { var mi = prov.Edts.GetModelInfo(edtName); if (mi?.Count > 0) result.Model = mi.First().Name; } catch { }
            if (edt is AxEdtString s) result.StringSize = SafeInt(() => s.StringSize, 0);
            if (edt is AxEdtEnum en) result.EnumType = Safe(() => en.EnumType);
            try { result.ReferenceTable = Safe(() => ((dynamic)edt).ReferenceTable?.Table); } catch { }

            // Gap-fill: additional properties
            try { result.FormHelp = Safe(() => edt.FormHelp); } catch { }
            try { result.ConfigurationKey = Safe(() => ((dynamic)edt).ConfigurationKey); } catch { }
            try { result.Alignment = Safe(() => ((dynamic)edt).Alignment?.ToString()); } catch { }
            try { result.DisplayLength = SafeInt(() => ((dynamic)edt).DisplayLength, 0); if (result.DisplayLength == 0) result.DisplayLength = null; } catch { }
            try { result.RelationType = Safe(() => ((dynamic)edt).RelationType?.ToString()); } catch { }

            // AxEdtReal specific
            if (edt is AxEdtReal r2)
            {
                try { result.NoOfDecimals = SafeInt(() => r2.NoOfDecimals, -1); if (result.NoOfDecimals == -1) result.NoOfDecimals = null; } catch { }
                try { result.DecimalSeparator = Safe(() => ((dynamic)r2).DecimalSeparator?.ToString()); } catch { }
                try { result.SignDisplay = Safe(() => ((dynamic)r2).SignDisplay?.ToString()); } catch { }
            }

            return result;
        }

        // ========================
        // FORM
        // ========================
        public FormInfoModel? ReadForm(string formName)
        {
            var prov = PickProvider(p => p.Forms.Exists(formName));
            if (prov == null) return null;
            var form = prov.Forms.Read(formName);
            if (form == null) return null;

            var result = new FormInfoModel { Name = form.Name };
            try { var mi = prov.Forms.GetModelInfo(formName); if (mi?.Count > 0) result.Model = mi.First().Name; } catch { }

            // Form pattern / style
            try { result.FormPattern = Safe(() => ((dynamic)form).Design?.Pattern) ?? Safe(() => ((dynamic)form).Design?.Style?.ToString()); } catch { }

            // Data sources with permissions
            try
            {
                if (form.DataSources != null)
                    foreach (var ds in form.DataSources)
                    {
                        var dsModel = new FormDataSourceModel
                        {
                            Name = ds.Name,
                            Table = Safe(() => ds.Table) ?? "",
                            JoinSource = Safe(() => ds.JoinSource),
                        };
                        try { dsModel.LinkType = Safe(() => ((dynamic)ds).LinkType?.ToString()); } catch { }
                        try { dsModel.AllowEdit = Safe(() => ((dynamic)ds).AllowEdit?.ToString()); } catch { }
                        try { dsModel.AllowCreate = Safe(() => ((dynamic)ds).AllowCreate?.ToString()); } catch { }
                        try { dsModel.AllowDelete = Safe(() => ((dynamic)ds).AllowDelete?.ToString()); } catch { }
                        result.DataSources.Add(dsModel);
                    }
            }
            catch (Exception ex) { Warn("datasources", formName, ex); }

            // Controls with extra properties
            try { if (form.Design?.Controls != null) MapControls(form.Design.Controls, result.Controls, 0); } catch (Exception ex) { Warn("controls", formName, ex); }

            // Methods
            try
            {
                dynamic dForm = form;
                if (dForm.SourceCode?.Methods != null)
                    foreach (dynamic m in dForm.SourceCode.Methods)
                    {
                        var mi = new MethodInfoModel { Name = Safe(() => (string)m.Name) ?? "" };
                        try { mi.Source = Safe(() => (string)m.Source); } catch { }
                        result.Methods.Add(mi);
                    }
            }
            catch (Exception ex) { Warn("methods", formName, ex); }

            return result;
        }

        private void MapControls(dynamic? controls, List<FormControlModel> target, int depth)
        {
            if (controls == null || depth > 15) return;
            try
            {
                foreach (dynamic c in controls!)
                {
                    try
                    {
                        var cm = new FormControlModel { Name = Safe(() => (string)c.Name) ?? "", ControlType = ((object)c).GetType().Name.Replace("AxFormControl", "") };
                        try { cm.DataSource = Safe(() => (string)c.DataSource); cm.DataField = Safe(() => (string)c.DataField); } catch { }
                        // Gap-fill: additional control properties
                        try { cm.Caption = Safe(() => (string)((dynamic)c).Caption); } catch { }
                        try { cm.Label = Safe(() => (string)((dynamic)c).Label); } catch { }
                        try { cm.HelpText = Safe(() => (string)((dynamic)c).HelpText); } catch { }
                        try { cm.Visible = Safe(() => ((dynamic)c).Visible?.ToString()); } catch { }
                        try { cm.Enabled = Safe(() => ((dynamic)c).Enabled?.ToString()); } catch { }
                        try { cm.DataMethod = Safe(() => (string)((dynamic)c).DataMethod); } catch { }
                        try { cm.AutoDeclaration = Safe(() => ((dynamic)c).AutoDeclaration?.ToString()); } catch { }
                        try { if (c.Controls != null) { cm.Children = new List<FormControlModel>(); MapControls(c.Controls, cm.Children, depth + 1); if (cm.Children.Count == 0) cm.Children = null; } } catch { }
                        target.Add(cm);
                    }
                    catch { }
                }
            }
            catch { }
        }

        // ========================
        // QUERY / VIEW / DATA ENTITY / REPORT
        // ========================
        public QueryInfoModel? ReadQuery(string queryName)
        {
            var prov = PickProvider(p => p.Queries.Exists(queryName));
            if (prov == null) return null;
            var q = prov.Queries.Read(queryName);
            if (q == null) return null;
            var result = new QueryInfoModel { Name = q.Name };
            try { var mi = prov.Queries.GetModelInfo(queryName); if (mi?.Count > 0) result.Model = mi.First().Name; } catch { }
            try { result.Description = Safe(() => ((dynamic)q).Description); } catch { }
            try { dynamic dq = q; if (dq.DataSources != null) foreach (dynamic ds in dq.DataSources) result.DataSources.Add(MapQueryDataSource(ds)); } catch (Exception ex) { Warn("dataSources", queryName, ex); }
            return result;
        }

        public ViewInfoModel? ReadView(string viewName)
        {
            var prov = PickProvider(p => p.Views.Exists(viewName));
            if (prov == null) return null;
            var v = prov.Views.Read(viewName);
            if (v == null) return null;
            var result = new ViewInfoModel { Name = v.Name, Label = Safe(() => v.Label), Query = Safe(() => v.Query) };
            try { var mi = prov.Views.GetModelInfo(viewName); if (mi?.Count > 0) result.Model = mi.First().Name; } catch { }

            // Gap-fill: isPublic, isReadOnly, PK
            try { result.IsPublic = IsYes(() => ((dynamic)v).IsPublic); } catch { }
            try { result.IsReadOnly = IsYes(() => ((dynamic)v).IsReadOnly); } catch { }
            try { if (!result.IsReadOnly) result.IsReadOnly = IsYes(() => ((dynamic)v).ViewMetadata.IsReadOnly); } catch { }
            try
            {
                dynamic dv = v;
                if (dv.Indexes != null)
                    foreach (dynamic idx in dv.Indexes)
                    {
                        try
                        {
                            bool isAk = false;
                            try { isAk = idx.AlternateKey?.ToString() == "Yes"; } catch { }
                            if (isAk || result.PrimaryKey == null)
                                result.PrimaryKey = Safe(() => (string)idx.Name);
                        }
                        catch { }
                    }
            }
            catch { }

            // Fields with data source / data field / data method
            try
            {
                if (v.Fields != null)
                    foreach (var f in v.Fields)
                    {
                        var vf = new ViewFieldModel { Name = f.Name, FieldType = f.GetType().Name.Replace("AxViewField", "") };
                        try { vf.DataSource = Safe(() => ((dynamic)f).DataSource); } catch { }
                        try { vf.DataField = Safe(() => ((dynamic)f).DataField); } catch { }
                        try { vf.DataMethod = Safe(() => ((dynamic)f).DataMethod); } catch { }
                        try { vf.Label = Safe(() => ((dynamic)f).Label); } catch { }
                        vf.IsComputed = !string.IsNullOrEmpty(vf.DataMethod) && string.IsNullOrEmpty(vf.DataField);
                        result.Fields.Add(vf);
                    }
            }
            catch { }

            // Relations
            try
            {
                dynamic dv2 = v;
                if (dv2.Relations != null)
                    foreach (dynamic rel in dv2.Relations)
                    {
                        var ri = new RelationInfoModel
                        {
                            Name = Safe(() => (string)rel.Name) ?? "",
                            RelatedTable = Safe(() => (string)rel.RelatedTable) ?? "",
                        };
                        try { ri.Cardinality = Safe(() => rel.Cardinality?.ToString()); } catch { }
                        try { ri.RelatedTableCardinality = Safe(() => rel.RelatedTableCardinality?.ToString()); } catch { }
                        try
                        {
                            if (rel.Constraints != null)
                                foreach (dynamic c in rel.Constraints)
                                {
                                    ri.Constraints.Add(new RelationConstraintModel
                                    {
                                        Field = Safe(() => (string)c.Field),
                                        RelatedField = Safe(() => (string)c.RelatedField),
                                    });
                                }
                        }
                        catch { }
                        result.Relations.Add(ri);
                    }
            }
            catch { }

            // Methods
            try
            {
                dynamic dv3 = v;
                if (dv3.SourceCode?.Methods != null)
                    foreach (dynamic m in dv3.SourceCode.Methods)
                    {
                        var mi2 = new MethodInfoModel { Name = Safe(() => (string)m.Name) ?? "" };
                        try { mi2.Source = Safe(() => (string)m.Source); } catch { }
                        result.Methods.Add(mi2);
                    }
            }
            catch { }

            // DataSources (from the view's query)
            try
            {
                dynamic dv4 = v;
                if (dv4.ViewMetadata?.DataSources != null)
                    foreach (dynamic ds in dv4.ViewMetadata.DataSources)
                    {
                        result.DataSources.Add(new FormDataSourceModel
                        {
                            Name = Safe(() => (string)ds.Name) ?? "",
                            Table = Safe(() => (string)ds.Table) ?? "",
                            JoinSource = Safe(() => (string)ds.JoinSource),
                        });
                    }
            }
            catch { }

            return result;
        }

        public DataEntityInfoModel? ReadDataEntity(string entityName)
        {
            var prov = PickProvider(p => p.DataEntityViews.Exists(entityName));
            if (prov == null) return null;
            var e = prov.DataEntityViews.Read(entityName);
            if (e == null) return null;
            var result = new DataEntityInfoModel { Name = e.Name, Label = Safe(() => e.Label), PublicEntityName = Safe(() => e.PublicEntityName), PublicCollectionName = Safe(() => e.PublicCollectionName), IsPublic = IsYes(() => e.IsPublic) };
            try { var mi = prov.DataEntityViews.GetModelInfo(entityName); if (mi?.Count > 0) result.Model = mi.First().Name; } catch { }

            // Gap-fill: isReadOnly, entityCategory, DMF, stagingTable
            try { result.IsReadOnly = IsYes(() => ((dynamic)e).IsReadOnly); } catch { }
            try { result.EntityCategory = Safe(() => ((dynamic)e).EntityCategory?.ToString()); } catch { }
            try { result.DataManagementEnabled = IsYes(() => ((dynamic)e).DataManagementEnabled); } catch { }
            try { result.StagingTable = Safe(() => ((dynamic)e).DataManagementStagingTable); } catch { }

            // Fields with extended info
            try
            {
                if (e.Fields != null)
                    foreach (var f in e.Fields)
                    {
                        var fi = new FieldInfoModel { Name = f.Name, FieldType = f.GetType().Name.Replace("AxDataEntityViewField", "").Replace("AxViewField", "") };
                        try { fi.Label = Safe(() => ((dynamic)f).Label); } catch { }
                        result.Fields.Add(fi);

                        // Field mappings
                        try
                        {
                            string? ds = Safe(() => ((dynamic)f).DataSource);
                            string? df = Safe(() => ((dynamic)f).DataField);
                            if (!string.IsNullOrEmpty(ds) || !string.IsNullOrEmpty(df))
                                result.FieldMappings.Add(new DataEntityFieldMappingModel { FieldName = f.Name, DataSource = ds, DataField = df });
                            else
                            {
                                // Computed column: has DataMethod but no DataField
                                string? dm = Safe(() => ((dynamic)f).DataMethod);
                                if (!string.IsNullOrEmpty(dm))
                                    result.ComputedColumns.Add(f.Name);
                            }
                        }
                        catch { }
                    }
            }
            catch { }

            // Data sources
            try { dynamic de = e; if (de.DataSources != null) foreach (dynamic ds in de.DataSources) result.DataSources.Add(new FormDataSourceModel { Name = Safe(() => (string)ds.Name) ?? "", Table = Safe(() => (string)ds.Table) ?? "" }); } catch (Exception ex) { Warn("dataSources", entityName, ex); }

            // Keys / indexes
            try
            {
                dynamic de2 = e;
                if (de2.Indexes != null)
                    foreach (dynamic idx in de2.Indexes)
                    {
                        var ki = new IndexInfoModel { Name = Safe(() => (string)idx.Name) ?? "" };
                        try { ki.AllowDuplicates = idx.AllowDuplicates?.ToString() == "Yes"; } catch { }
                        try { ki.AlternateKey = idx.AlternateKey?.ToString() == "Yes"; } catch { }
                        try
                        {
                            if (idx.Fields != null)
                                foreach (dynamic fld in idx.Fields)
                                    ki.Fields.Add(new IndexFieldModel { DataField = Safe(() => (string)fld.DataField) ?? "" });
                        }
                        catch { }
                        result.Keys.Add(ki);
                    }
            }
            catch { }

            return result;
        }

        public ReportInfoModel? ReadReport(string reportName)
        {
            try
            {
                var prov = PickProvider(p => p.Reports.Exists(reportName));
                if (prov == null) return null;
                var r = prov.Reports.Read(reportName);
                if (r == null) return null;
                var result = new ReportInfoModel { Name = r.Name };
                try { var mi = prov.Reports.GetModelInfo(reportName); if (mi?.Count > 0) result.Model = mi.First().Name; } catch { }

                // DataSets with fields and type info
                try
                {
                    if (r.DataSets != null)
                        foreach (dynamic ds in r.DataSets)
                        {
                            var dsModel = new ReportDataSetModel { Name = Safe(() => (string)ds.Name) ?? "Unknown" };
                            try { dsModel.DataSourceType = Safe(() => ds.DataSourceType?.ToString()); } catch { }
                            try { dsModel.Query = Safe(() => (string)ds.Query); } catch { }
                            try
                            {
                                if (ds.Fields != null)
                                    foreach (dynamic f in ds.Fields)
                                    {
                                        dsModel.Fields.Add(new ReportDataSetFieldModel
                                        {
                                            Name = Safe(() => (string)f.Name) ?? "",
                                            DataField = Safe(() => (string)f.DataField),
                                            DataType = Safe(() => f.DataType?.ToString()),
                                        });
                                    }
                            }
                            catch { }
                            result.DataSets.Add(dsModel);
                        }
                }
                catch { }

                // Designs
                try
                {
                    dynamic dr = r;
                    if (dr.Designs != null)
                        foreach (dynamic d in dr.Designs)
                        {
                            var dm = new ReportDesignModel { Name = Safe(() => (string)d.Name) ?? "" };
                            try { dm.Caption = Safe(() => (string)d.Caption); } catch { }
                            try { dm.Style = Safe(() => (string)d.Style); } catch { }
                            try { dm.HasRdl = !string.IsNullOrEmpty(Safe(() => (string)d.Text)); } catch { }
                            result.Designs.Add(dm);
                        }
                }
                catch { }

                return result;
            }
            catch { return null; }
        }

        private QueryDataSourceModel MapQueryDataSource(dynamic ds)
        {
            var model = new QueryDataSourceModel { Name = Safe(() => (string)ds.Name) ?? "", Table = Safe(() => (string)ds.Table) ?? "" };
            try { model.JoinMode = Safe(() => ds.JoinMode?.ToString()); } catch { }
            try { model.FetchMode = Safe(() => ds.FetchMode?.ToString()); } catch { }

            // Ranges
            try
            {
                if (ds.Ranges != null)
                {
                    model.Ranges = new List<QueryRangeModel>();
                    foreach (dynamic range in ds.Ranges)
                    {
                        model.Ranges.Add(new QueryRangeModel
                        {
                            Field = Safe(() => (string)range.Field) ?? "",
                            Value = Safe(() => (string)range.Value),
                            Status = Safe(() => range.Status?.ToString()),
                        });
                    }
                    if (model.Ranges.Count == 0) model.Ranges = null;
                }
            }
            catch { }

            // Fields
            try
            {
                if (ds.Fields?.Dynamic?.ToString() != "Yes" && ds.Fields != null)
                {
                    model.Fields = new List<string>();
                    foreach (dynamic f in ds.Fields)
                    {
                        string? fn = Safe(() => (string)f.Field);
                        if (!string.IsNullOrEmpty(fn)) model.Fields.Add(fn!);
                    }
                    if (model.Fields.Count == 0) model.Fields = null;
                }
            }
            catch { }

            // Child data sources
            try
            {
                if (ds.DataSources != null)
                {
                    model.ChildDataSources = new List<QueryDataSourceModel>();
                    foreach (dynamic child in ds.DataSources) model.ChildDataSources.Add(MapQueryDataSource(child));
                    if (model.ChildDataSources.Count == 0) model.ChildDataSources = null;
                }
            }
            catch { }
            return model;
        }

        // ========================
        // CAPABILITIES
        // ========================

        /// <summary>
        /// Returns a capabilities map listing available modification operations per object type.
        /// This is a static declaration — no reflection needed.
        /// </summary>
        public CapabilitiesModel GetCapabilities()
        {
            return new CapabilitiesModel
            {
                ObjectTypes = new Dictionary<string, List<string>>
                {
                    ["table"] = new List<string> { "add-field", "modify-field", "rename-field", "replace-all-fields", "remove-field", "add-index", "remove-index", "add-relation", "remove-relation", "add-field-group", "remove-field-group", "add-field-to-field-group", "add-method", "remove-method", "replace-code", "modify-property" },
                    ["table-extension"] = new List<string> { "add-field", "modify-field", "rename-field", "remove-field", "add-index", "remove-index", "add-relation", "remove-relation", "add-field-group", "remove-field-group", "add-field-to-field-group", "add-field-modification", "add-method", "remove-method", "replace-code", "modify-property" },
                    ["class"] = new List<string> { "add-method", "remove-method", "replace-code", "modify-property" },
                    ["class-extension"] = new List<string> { "add-method", "remove-method", "replace-code", "modify-property" },
                    ["form"] = new List<string> { "add-method", "remove-method", "replace-code", "modify-property" },
                    ["form-extension"] = new List<string> { "add-control", "add-data-source", "add-method", "remove-method", "replace-code", "modify-property" },
                    ["enum"] = new List<string> { "modify-property" },
                    ["edt"] = new List<string> { "modify-property" },
                    ["view"] = new List<string> { "add-method", "remove-method", "replace-code", "modify-property" },
                    ["query"] = new List<string> { "modify-property" },
                    ["report"] = new List<string> { "modify-property" },
                }
            };
        }

        // ========================
        // FORM PATTERN DISCOVERY
        // ========================

        /// <summary>
        /// Discovers available D365FO form patterns by attempting to load
        /// Microsoft.Dynamics.AX.Metadata.Patterns.dll from the D365FO bin directory.
        /// Falls back to a hardcoded list of well-known patterns.
        /// </summary>
        public FormPatternDiscoveryResult DiscoverFormPatterns()
        {
            var result = new FormPatternDiscoveryResult();

            // Attempt runtime discovery from PatternFactory
            try
            {
                var binPath = System.IO.Path.Combine(_packagesPath, "bin");
                var patternsDll = System.IO.Path.Combine(binPath, "Microsoft.Dynamics.AX.Metadata.Patterns.dll");

                if (System.IO.File.Exists(patternsDll))
                {
                    var assembly = System.Reflection.Assembly.LoadFrom(patternsDll);
                    var factoryType = assembly.GetType("Microsoft.Dynamics.AX.Metadata.Patterns.PatternFactory");

                    if (factoryType != null)
                    {
                        var getAllMethod = factoryType.GetMethod("GetAllPatterns", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static);
                        if (getAllMethod != null)
                        {
                            var patterns = getAllMethod.Invoke(null, null) as System.Collections.IEnumerable;
                            if (patterns != null)
                            {
                                foreach (dynamic p in patterns)
                                {
                                    try
                                    {
                                        result.Patterns.Add(new FormPatternModel
                                        {
                                            Name = Safe(() => (string)p.Name) ?? "",
                                            Version = Safe(() => p.Version?.ToString() as string),
                                            Description = Safe(() => (string)p.Description),
                                        });
                                    }
                                    catch { }
                                }
                                result.Count = result.Patterns.Count;
                                result.Source = "runtime";
                                Console.Error.WriteLine($"[INFO] Discovered {result.Count} form patterns from Patterns DLL");
                                return result;
                            }
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WARN] Pattern discovery via DLL failed: {ex.Message}");
            }

            // Fallback: well-known patterns
            var knownPatterns = new[] {
                ("SimpleList", "Simple flat list of records"),
                ("SimpleListDetails", "List with details pane"),
                ("DetailsMaster", "Master record form with header and lines"),
                ("DetailsTransaction", "Transaction form with header and lines"),
                ("Dialog", "Modal dialog box"),
                ("DropDialog", "Drop dialog (compact dialog)"),
                ("TableOfContents", "Navigation form with sections"),
                ("ListPage", "Browse/filter list page"),
                ("Lookup", "Lookup form for field selection"),
                ("FactBox", "FactBox information panel"),
                ("FormPart", "Embedded form part"),
                ("Workspace", "Operational workspace with panorama sections"),
                ("WizardDialog", "Multi-step wizard dialog"),
            };

            foreach (var (name, desc) in knownPatterns)
                result.Patterns.Add(new FormPatternModel { Name = name, Description = desc });

            result.Count = result.Patterns.Count;
            result.Source = "hardcoded";
            return result;
        }

        // ========================
        // SEARCH / LIST
        // ========================
        public SearchResultModel SearchObjects(string type, string query, int maxResults)
        {
            var result = new SearchResultModel();
            // seen set prevents duplicate names when the same object exists in both providers
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            void Search(string objType, IList<string> keys)
            {
                if (keys == null) return;
                foreach (var n in keys)
                {
                    if (result.Results.Count >= maxResults) return;
                    if (n.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0 && seen.Add(n))
                        result.Results.Add(new SearchItemModel { Name = n, Type = objType });
                }
            }

            // Materialize primary keys from a provider collection.
            // IMPORTANT: these are accessed STRONGLY-TYPED through the public
            // Microsoft.Dynamics.AX.Metadata.Providers.IMetadataProvider interface — NOT via
            // `dynamic`. The concrete provider (DiskMetadataProvider) is an internal type, and
            // the DLR cannot bind to public members of an internal type from this assembly:
            // `dynamic dyn = prov; dyn.MenuItemDisplays` throws RuntimeBinderException
            // ("'object' does not contain a definition for 'MenuItemDisplays'") and silently
            // yields nothing — which is exactly how menu items/security stayed invisible.
            // Interface access binds at compile time and works. Keys are enumerated (not cast
            // to IList<string>) so a lazy IEnumerable<string> return is handled safely too.
            List<string> Keys(string label, Func<IEnumerable<string>> getter)
            {
                var list = new List<string>();
                try
                {
                    var raw = getter();
                    if (raw != null)
                        foreach (var k in raw) list.Add(k);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[WARN] Search: could not list '{label}': {ex.GetType().Name}: {ex.Message}");
                }
                return list;
            }

            void SearchProvider(IMetadataProvider prov)
            {
                try
                {
                    switch (type.ToLowerInvariant())
                    {
                        case "table": Search("table", Keys("table", () => prov.Tables.GetPrimaryKeys())); break;
                        case "class": Search("class", Keys("class", () => prov.Classes.GetPrimaryKeys())); break;
                        case "enum": Search("enum", Keys("enum", () => prov.Enums.GetPrimaryKeys())); break;
                        case "edt": Search("edt", Keys("edt", () => prov.Edts.GetPrimaryKeys())); break;
                        case "form": Search("form", Keys("form", () => prov.Forms.GetPrimaryKeys())); break;
                        case "query": Search("query", Keys("query", () => prov.Queries.GetPrimaryKeys())); break;
                        case "view": Search("view", Keys("view", () => prov.Views.GetPrimaryKeys())); break;
                        case "data-entity":
                        case "dataentity": Search("data-entity", Keys("data-entity", () => prov.DataEntityViews.GetPrimaryKeys())); break;

                        case "menu-item-display": Search("menu-item-display", Keys("menu-item-display", () => prov.MenuItemDisplays.GetPrimaryKeys())); break;
                        case "menu-item-action": Search("menu-item-action", Keys("menu-item-action", () => prov.MenuItemActions.GetPrimaryKeys())); break;
                        case "menu-item-output": Search("menu-item-output", Keys("menu-item-output", () => prov.MenuItemOutputs.GetPrimaryKeys())); break;

                        case "security-privilege": Search("security-privilege", Keys("security-privilege", () => prov.SecurityPrivileges.GetPrimaryKeys())); break;
                        case "security-duty": Search("security-duty", Keys("security-duty", () => prov.SecurityDuties.GetPrimaryKeys())); break;
                        case "security-role": Search("security-role", Keys("security-role", () => prov.SecurityRoles.GetPrimaryKeys())); break;

                        case "table-extension": Search("table-extension", Keys("table-extension", () => prov.TableExtensions.GetPrimaryKeys())); break;
                        // IMetadataProvider has no ClassExtensions collection — CoC/augmentation
                        // classes live in the regular Classes collection (named *_Extension). The
                        // bridge can't filter them out here, so return nothing and let the caller
                        // fall back to the SQLite index, which indexes class-extension explicitly.
                        case "class-extension":
                            Console.Error.WriteLine("[DEBUG] Search: class-extension requested — no IMetadataProvider collection; falling back to SQLite index");
                            break;
                        case "form-extension": Search("form-extension", Keys("form-extension", () => prov.FormExtensions.GetPrimaryKeys())); break;
                        case "enum-extension": Search("enum-extension", Keys("enum-extension", () => prov.EnumExtensions.GetPrimaryKeys())); break;
                        case "edt-extension": Search("edt-extension", Keys("edt-extension", () => prov.EdtExtensions.GetPrimaryKeys())); break;
                        case "data-entity-extension": Search("data-entity-extension", Keys("data-entity-extension", () => prov.DataEntityViewExtensions.GetPrimaryKeys())); break;

                        default:
                            // "all" (or any unrecognized filter): enumerate every object kind so
                            // nothing — menu items included — is silently invisible to search.
                            Search("table", Keys("table", () => prov.Tables.GetPrimaryKeys()));
                            Search("class", Keys("class", () => prov.Classes.GetPrimaryKeys()));
                            Search("enum", Keys("enum", () => prov.Enums.GetPrimaryKeys()));
                            Search("edt", Keys("edt", () => prov.Edts.GetPrimaryKeys()));
                            Search("form", Keys("form", () => prov.Forms.GetPrimaryKeys()));
                            Search("query", Keys("query", () => prov.Queries.GetPrimaryKeys()));
                            Search("view", Keys("view", () => prov.Views.GetPrimaryKeys()));
                            Search("data-entity", Keys("data-entity", () => prov.DataEntityViews.GetPrimaryKeys()));
                            Search("menu-item-display", Keys("menu-item-display", () => prov.MenuItemDisplays.GetPrimaryKeys()));
                            Search("menu-item-action", Keys("menu-item-action", () => prov.MenuItemActions.GetPrimaryKeys()));
                            Search("menu-item-output", Keys("menu-item-output", () => prov.MenuItemOutputs.GetPrimaryKeys()));
                            Search("security-privilege", Keys("security-privilege", () => prov.SecurityPrivileges.GetPrimaryKeys()));
                            Search("security-duty", Keys("security-duty", () => prov.SecurityDuties.GetPrimaryKeys()));
                            Search("security-role", Keys("security-role", () => prov.SecurityRoles.GetPrimaryKeys()));
                            break;
                    }
                }
                catch (Exception ex) { Console.Error.WriteLine($"[WARN] Search error: {ex.Message}"); }
            }

            // Search primary provider first, then reference provider (UDE fallback)
            SearchProvider(_provider);
            if (_referenceProvider != null && result.Results.Count < maxResults)
                SearchProvider(_referenceProvider);

            result.TotalCount = result.Results.Count;
            return result;
        }

        // ========================
        // SECURITY ARTIFACTS (Phase 6 — bridge read)
        // ========================

        /// <summary>
        /// Read a security privilege via IMetadataProvider, including entry points and parent duties.
        /// </summary>
        public object? ReadSecurityPrivilege(string name)
        {
            try
            {
                // Access collections via IMetadataProvider interface (compile-time binding).
                // Avoids RuntimeBinderException when DiskMetadataProvider (internal type)
                // is accessed through dynamic from another assembly.
                var privileges = _provider.SecurityPrivileges;
                dynamic? axObj = privileges.Read(name);
                // Fallback to reference provider (UDE: Microsoft packages)
                if (axObj == null && _referenceProvider != null)
                {
                    privileges = _referenceProvider!.SecurityPrivileges;
                    axObj = privileges.Read(name);
                }
                if (axObj == null) return null;

                string? model = null;
                try { var mi = privileges.GetModelInfo(name); if (mi?.Count > 0) model = mi.First().Name; } catch { }

                var entryPoints = new List<object>();
                try
                {
                    foreach (var ep in axObj.EntryPoints)
                    {
                        entryPoints.Add(new
                        {
                            objectType = Safe(() => (string)ep.ObjectType.ToString()),
                            objectName = Safe(() => (string)ep.ObjectName),
                            accessLevel = Safe(() => (string)ep.Grant.ToString()),
                        });
                    }
                }
                catch { }

                // Find parent duties that contain this privilege
                var parentDuties = new List<object>();
                try
                {
                    foreach (var dutyName in _provider.SecurityDuties.GetPrimaryKeys())
                    {
                        try
                        {
                            dynamic duty = _provider.SecurityDuties.Read(dutyName);
                            if (duty?.Privileges == null) continue;
                            foreach (var p in duty.Privileges)
                            {
                                if ((string)p.Name == name)
                                {
                                    parentDuties.Add(new { name = dutyName });
                                    break;
                                }
                            }
                        }
                        catch { }
                    }
                }
                catch { }

                return new
                {
                    artifactType = "privilege",
                    name = (string)axObj.Name,
                    label = Safe(() => (string)axObj.Label),
                    description = Safe(() => (string)axObj.Description),
                    model,
                    entryPoints,
                    parentDuties,
                    _source = "C# bridge (IMetadataProvider)"
                };
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WARN] ReadSecurityPrivilege({name}): {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// Read a security duty via IMetadataProvider, including child privileges and parent roles.
        /// </summary>
        public object? ReadSecurityDuty(string name)
        {
            try
            {
                // Access collections via IMetadataProvider interface (compile-time binding).
                // Avoids RuntimeBinderException when DiskMetadataProvider (internal type)
                // is accessed through dynamic from another assembly.
                var duties = _provider.SecurityDuties;
                dynamic? axObj = duties.Read(name);
                // Fallback to reference provider (UDE: Microsoft packages)
                if (axObj == null && _referenceProvider != null)
                {
                    duties = _referenceProvider!.SecurityDuties;
                    axObj = duties.Read(name);
                }
                if (axObj == null) return null;

                string? model = null;
                try { var mi = duties.GetModelInfo(name); if (mi?.Count > 0) model = mi.First().Name; } catch { }

                var childPrivileges = new List<object>();
                try
                {
                    foreach (var p in axObj.Privileges)
                    {
                        childPrivileges.Add(new { name = Safe(() => (string)p.Name) });
                    }
                }
                catch { }

                var subDuties = new List<object>();
                try
                {
                    foreach (var d in axObj.SubDuties)
                    {
                        subDuties.Add(new { name = Safe(() => (string)d.Name) });
                    }
                }
                catch { }

                // Find parent roles that contain this duty
                var parentRoles = new List<object>();
                try
                {
                    foreach (var roleName in _provider.SecurityRoles.GetPrimaryKeys())
                    {
                        try
                        {
                            dynamic role = _provider.SecurityRoles.Read(roleName);
                            if (role?.Duties == null) continue;
                            foreach (var d in role.Duties)
                            {
                                if ((string)d.Name == name)
                                {
                                    parentRoles.Add(new { name = roleName });
                                    break;
                                }
                            }
                        }
                        catch { }
                    }
                }
                catch { }

                return new
                {
                    artifactType = "duty",
                    name = (string)axObj.Name,
                    label = Safe(() => (string)axObj.Label),
                    description = Safe(() => (string)axObj.Description),
                    model,
                    childPrivileges,
                    subDuties,
                    parentRoles,
                    _source = "C# bridge (IMetadataProvider)"
                };
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WARN] ReadSecurityDuty({name}): {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// Read a security role via IMetadataProvider, including child duties and privileges.
        /// </summary>
        public object? ReadSecurityRole(string name)
        {
            try
            {
                // Access collections via IMetadataProvider interface (compile-time binding).
                // Avoids RuntimeBinderException when DiskMetadataProvider (internal type)
                // is accessed through dynamic from another assembly.
                var roles = _provider.SecurityRoles;
                dynamic? axObj = roles.Read(name);
                // Fallback to reference provider (UDE: Microsoft packages)
                if (axObj == null && _referenceProvider != null)
                {
                    roles = _referenceProvider!.SecurityRoles;
                    axObj = roles.Read(name);
                }
                if (axObj == null) return null;

                string? model = null;
                try { var mi = roles.GetModelInfo(name); if (mi?.Count > 0) model = mi.First().Name; } catch { }

                var childDuties = new List<object>();
                try
                {
                    foreach (var d in axObj.Duties)
                    {
                        childDuties.Add(new { name = Safe(() => (string)d.Name) });
                    }
                }
                catch { }

                var childPrivileges = new List<object>();
                try
                {
                    foreach (var p in axObj.Privileges)
                    {
                        childPrivileges.Add(new { name = Safe(() => (string)p.Name) });
                    }
                }
                catch { }

                var subRoles = new List<object>();
                try
                {
                    foreach (var sr in axObj.SubRoles)
                    {
                        subRoles.Add(new { name = Safe(() => (string)sr.Name) });
                    }
                }
                catch { }

                return new
                {
                    artifactType = "role",
                    name = (string)axObj.Name,
                    label = Safe(() => (string)axObj.Label),
                    description = Safe(() => (string)axObj.Description),
                    model,
                    childDuties,
                    childPrivileges,
                    subRoles,
                    _source = "C# bridge (IMetadataProvider)"
                };
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WARN] ReadSecurityRole({name}): {ex.Message}");
                return null;
            }
        }

        // ========================
        // MENU ITEM (Phase 6 — bridge read)
        // ========================

        /// <summary>
        /// Read a menu item (display/action/output) via IMetadataProvider.
        /// Tries all 3 types if itemType is "any".
        /// </summary>
        public object? ReadMenuItem(string name, string itemType = "any")
        {
            try
            {
                var tryTypes = itemType.ToLowerInvariant() switch
                {
                    "display" => new[] { "display" },
                    "action" => new[] { "action" },
                    "output" => new[] { "output" },
                    _ => new[] { "display", "action", "output" }
                };

                // Try primary provider first, then reference provider (UDE fallback)
                foreach (var prov in new[] { _provider, _referenceProvider }.Where(p => p != null))
                {
                    foreach (var tryType in tryTypes)
                    {
                        try
                        {
                            // Access collections via IMetadataProvider interface (compile-time binding).
                            // Avoids RuntimeBinderException when DiskMetadataProvider (internal type)
                            // is accessed through dynamic from another assembly.
                            dynamic? axObj = tryType switch
                            {
                                "display" => (object?)prov!.MenuItemDisplays.Read(name),
                                "action"  => (object?)prov!.MenuItemActions.Read(name),
                                "output"  => (object?)prov!.MenuItemOutputs.Read(name),
                                _ => throw new InvalidOperationException()
                            };
                            if (axObj == null) continue;

                            string? model = null;
                            try
                            {
                                var rawMi = tryType switch
                                {
                                    "display" => (object?)prov!.MenuItemDisplays.GetModelInfo(name),
                                    "action"  => (object?)prov!.MenuItemActions.GetModelInfo(name),
                                    _         => (object?)prov!.MenuItemOutputs.GetModelInfo(name),
                                };
                                if (rawMi != null) { dynamic dmi = rawMi; if (dmi.Count > 0) model = (string?)dmi.First().Name; }
                            }
                            catch { }

                            return new
                            {
                                name = (string)axObj.Name,
                                menuItemType = tryType,
                                label = Safe(() => (string)axObj.Label),
                                helpText = Safe(() => (string)axObj.HelpText),
                                objectType = Safe(() => (string)axObj.ObjectType.ToString()),
                                @object = Safe(() => (string)axObj.Object),
                                openMode = Safe(() => (string)axObj.OpenMode.ToString()),
                                linkedPermissionType = Safe(() => (string)axObj.LinkedPermissionType.ToString()),
                                linkedPermissionObject = Safe(() => (string)axObj.LinkedPermissionObject),
                                model,
                                _source = "C# bridge (IMetadataProvider)"
                            };
                        }
                        catch { }
                    }
                    // not found in this provider — try the next one
                }
                return null;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WARN] ReadMenuItem({name}, {itemType}): {ex.Message}");
                return null;
            }
        }

        // ========================
        // TABLE EXTENSIONS (Phase 6 — bridge read)
        // ========================

        /// <summary>
        /// List all table extensions for a given base table by enumerating TableExtensions
        /// whose name starts with "{baseTable}." (D365FO naming convention).
        /// </summary>
        public object? ReadTableExtensions(string baseTableName)
        {
            try
            {
                var prefix = $"{baseTableName}.";
                var extensions = new List<object>();
                var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

                void CollectExtensions(IMetadataProvider prov)
                {
                    try
                    {
                        var allExtKeys = prov.TableExtensions.GetPrimaryKeys();
                        foreach (var extName in allExtKeys)
                        {
                            if (!extName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
                            if (!seen.Add(extName)) continue; // already collected from primary

                            try
                            {
                                var ext = prov.TableExtensions.Read(extName);
                                if (ext == null) continue;

                                string? model = null;
                                try { var mi = prov.TableExtensions.GetModelInfo(extName); if (mi?.Count > 0) model = mi.First().Name; } catch { }

                                var addedFields = new List<string>();
                                try { foreach (var f in ext.Fields) addedFields.Add(f.Name); } catch { }

                                var addedIndexes = new List<string>();
                                try { foreach (var i in ext.Indexes) addedIndexes.Add(i.Name); } catch { }

                                var addedFieldGroups = new List<string>();
                                try { foreach (var g in ext.FieldGroups) addedFieldGroups.Add(g.Name); } catch { }

                                var addedRelations = new List<string>();
                                try { foreach (var r in ext.Relations) addedRelations.Add(r.Name); } catch { }

                                extensions.Add(new
                                {
                                    extensionName = extName,
                                    model,
                                    addedFields,
                                    addedIndexes,
                                    addedFieldGroups,
                                    addedRelations,
                                });
                            }
                            catch { }
                        }
                    }
                    catch { }
                }

                // Collect from primary provider first, then reference provider (UDE fallback)
                CollectExtensions(_provider);
                if (_referenceProvider != null) CollectExtensions(_referenceProvider);

                return new
                {
                    baseTable = baseTableName,
                    extensionCount = extensions.Count,
                    extensions,
                    _source = "C# bridge (IMetadataProvider)"
                };
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WARN] ReadTableExtensions({baseTableName}): {ex.Message}");
                return null;
            }
        }

        // ========================
        // CODE COMPLETION (Phase 6 — bridge read)
        // ========================

        /// <summary>
        /// Returns method/field members for a class or table, suitable for code completion.
        /// For classes: methods from SourceCode/Methods.
        /// For tables: fields + methods.
        /// </summary>
        public object? GetCompletionMembers(string symbolName)
        {
            try
            {
                // Try as class first (primary then reference provider)
                var classProv = PickProvider(p => p.Classes.Exists(symbolName));
                if (classProv != null)
                {
                    var cls = classProv.Classes.Read(symbolName);
                    if (cls == null) return null;

                    var methods = new List<object>();
                    try
                    {
                        foreach (var m in cls.Methods)
                        {
                            // Extract first line of Source as signature
                            string? sig = null;
                            try
                            {
                                var src = m.Source;
                                if (!string.IsNullOrEmpty(src))
                                {
                                    // Find the first non-comment, non-attribute, non-blank line
                                    foreach (var line in src.Split('\n'))
                                    {
                                        var trimmed = line.Trim();
                                        if (string.IsNullOrEmpty(trimmed) || trimmed.StartsWith("//") ||
                                            trimmed.StartsWith("/*") || trimmed.StartsWith("*") ||
                                            trimmed.StartsWith("[") || trimmed == "{") continue;
                                        sig = trimmed.TrimEnd('{').Trim();
                                        break;
                                    }
                                }
                            }
                            catch { }
                            methods.Add(new { name = m.Name, signature = sig, kind = "method" });
                        }
                    }
                    catch { }

                    string? model = null;
                    try { var mi = classProv.Classes.GetModelInfo(symbolName); if (mi?.Count > 0) model = mi.First().Name; } catch { }

                    return new
                    {
                        symbolName,
                        symbolType = "class",
                        model,
                        members = methods,
                        _source = "C# bridge (IMetadataProvider)"
                    };
                }

                // Try as table (primary then reference provider)
                var tableProv2 = PickProvider(p => p.Tables.Exists(symbolName));
                if (tableProv2 != null)
                {
                    var tbl = tableProv2.Tables.Read(symbolName);
                    if (tbl == null) return null;

                    var members = new List<object>();
                    try { foreach (var f in tbl.Fields) members.Add(new { name = f.Name, signature = $"{f.Name} : {f.GetType().Name.Replace("AxTableField", "")}", kind = "field" }); } catch { }
                    try { foreach (var m in tbl.Methods) members.Add(new { name = m.Name, signature = (string?)null, kind = "method" }); } catch { }

                    string? model = null;
                    try { var mi = tableProv2.Tables.GetModelInfo(symbolName); if (mi?.Count > 0) model = mi.First().Name; } catch { }

                    return new
                    {
                        symbolName,
                        symbolType = "table",
                        model,
                        members,
                        _source = "C# bridge (IMetadataProvider)"
                    };
                }

                return null;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WARN] GetCompletionMembers({symbolName}): {ex.Message}");
                return null;
            }
        }

        public object ListObjects(string type)
        {
            IList<string> GetKeys(IMetadataProvider prov) => type.ToLowerInvariant() switch
            {
                "table" => prov.Tables.GetPrimaryKeys(),
                "class" => prov.Classes.GetPrimaryKeys(),
                "enum" => prov.Enums.GetPrimaryKeys(),
                "edt" => prov.Edts.GetPrimaryKeys(),
                "form" => prov.Forms.GetPrimaryKeys(),
                "view" => prov.Views.GetPrimaryKeys(),
                "query" => prov.Queries.GetPrimaryKeys(),
                "dataentity" => prov.DataEntityViews.GetPrimaryKeys(),
                _ => new List<string>()
            };

            // Merge keys from both providers (deduplicated)
            var allKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try { foreach (var k in GetKeys(_provider)) allKeys.Add(k); } catch { }
            if (_referenceProvider != null)
            {
                try { foreach (var k in GetKeys(_referenceProvider)) allKeys.Add(k); } catch { }
            }
            var keys = allKeys.OrderBy(k => k).ToList();
            return new { type, count = keys.Count, names = keys };
        }

        // ========================
        // HELPERS
        // ========================
        private static string? Safe(Func<string?> f) { try { return f(); } catch { return null; } }
        private static bool IsYes(Func<object> f) { try { return f()?.ToString() == "Yes"; } catch { return false; } }
        private static int SafeInt(Func<int> f, int d) { try { return f(); } catch { return d; } }
        private static void Warn(string section, string obj, Exception ex) => Console.Error.WriteLine($"[WARN] Error reading {section} for {obj}: {ex.Message}");

        // ========================
        // DIAGNOSTIC: Probe IMetadataProvider write capability
        // ========================

        private FieldInfoModel MapField(AxTableField field)
        {
            var m = new FieldInfoModel
            {
                Name = field.Name,
                FieldType = field.GetType().Name.Replace("AxTableField", ""),
                ExtendedDataType = Safe(() => field.ExtendedDataType),
                Label = Safe(() => field.Label),
                HelpText = Safe(() => field.HelpText),
                Mandatory = IsYes(() => field.Mandatory),
                AllowEdit = Safe(() => field.AllowEdit.ToString()),
            };
            if (field is AxTableFieldString s) m.StringSize = SafeInt(() => s.StringSize, 0);
            if (field is AxTableFieldEnum en) m.EnumType = Safe(() => en.EnumType);
            return m;
        }
    }
}
