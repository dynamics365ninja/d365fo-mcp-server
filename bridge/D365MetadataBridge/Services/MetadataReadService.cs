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

        /// <summary>
        /// Exposes the current provider for MetadataWriteService initialization.
        /// </summary>
        public IMetadataProvider Provider => _provider;

        /// <summary>
        /// Optional callback invoked after RefreshProvider() so the write service can stay in sync.
        /// </summary>
        public Action<IMetadataProvider>? OnProviderRefreshed { get; set; }

        public MetadataReadService(string packagesPath)
        {
            _packagesPath = packagesPath;
            // Use DiskProvider (standalone mode) — avoids .NET Framework EventDescriptor dependency
            var factory = new MetadataProviderFactory();
            _provider = factory.CreateDiskProvider(packagesPath);
            Console.Error.WriteLine($"[MetadataService] Initialized via DiskProvider: {packagesPath}");
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
            _provider = factory.CreateDiskProvider(_packagesPath);
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

                    case "report":
                        if (!_provider.Reports.Exists(objectName)) return new { valid = false, reason = $"Report '{objectName}' not found by IMetadataProvider after refresh" };
                        return new { valid = true, objectType, objectName };

                    default:
                        return new { valid = false, reason = $"Unsupported objectType for validation: {objectType}" };
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
                        if (!_provider.Tables.Exists(objectName)) return null;
                        string? model = null;
                        try { var mi = _provider.Tables.GetModelInfo(objectName); if (mi?.Count > 0) model = mi.First().Name; } catch { }
                        return new { exists = true, objectType, objectName, model };
                    }
                    case "class":
                    case "class-extension":
                    {
                        if (!_provider.Classes.Exists(objectName)) return null;
                        string? model = null;
                        try { var mi = _provider.Classes.GetModelInfo(objectName); if (mi?.Count > 0) model = mi.First().Name; } catch { }
                        return new { exists = true, objectType, objectName, model };
                    }
                    case "enum":
                    {
                        if (!_provider.Enums.Exists(objectName)) return null;
                        string? model = null;
                        try { var mi = _provider.Enums.GetModelInfo(objectName); if (mi?.Count > 0) model = mi.First().Name; } catch { }
                        return new { exists = true, objectType, objectName, model };
                    }
                    case "edt":
                    {
                        if (!_provider.Edts.Exists(objectName)) return null;
                        string? model = null;
                        try { var mi = _provider.Edts.GetModelInfo(objectName); if (mi?.Count > 0) model = mi.First().Name; } catch { }
                        return new { exists = true, objectType, objectName, model };
                    }
                    case "form":
                    case "form-extension":
                    {
                        if (!_provider.Forms.Exists(objectName)) return null;
                        string? model = null;
                        try { var mi = _provider.Forms.GetModelInfo(objectName); if (mi?.Count > 0) model = mi.First().Name; } catch { }
                        return new { exists = true, objectType, objectName, model };
                    }
                    case "query":
                    {
                        if (!_provider.Queries.Exists(objectName)) return null;
                        string? model = null;
                        try { var mi = _provider.Queries.GetModelInfo(objectName); if (mi?.Count > 0) model = mi.First().Name; } catch { }
                        return new { exists = true, objectType, objectName, model };
                    }
                    case "view":
                    {
                        if (!_provider.Views.Exists(objectName)) return null;
                        string? model = null;
                        try { var mi = _provider.Views.GetModelInfo(objectName); if (mi?.Count > 0) model = mi.First().Name; } catch { }
                        return new { exists = true, objectType, objectName, model };
                    }
                    case "report":
                    {
                        if (!_provider.Reports.Exists(objectName)) return null;
                        string? model = null;
                        try { var mi = _provider.Reports.GetModelInfo(objectName); if (mi?.Count > 0) model = mi.First().Name; } catch { }
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
            if (!_provider.Tables.Exists(tableName)) return null;
            var table = _provider.Tables.Read(tableName);
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
            };

            try { var mi = _provider.Tables.GetModelInfo(tableName); if (mi?.Count > 0) result.Model = mi.First().Name; } catch { }

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
            if (!_provider.Classes.Exists(className)) return null;
            var cls = _provider.Classes.Read(className);
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

            try { var mi = _provider.Classes.GetModelInfo(className); if (mi?.Count > 0) result.Model = mi.First().Name; } catch { }

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

            // Try class first
            if (_provider.Classes.Exists(className))
            {
                var cls = _provider.Classes.Read(className);
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

            // Try table
            if (_provider.Tables.Exists(className))
            {
                var table = _provider.Tables.Read(className);
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
            if (!_provider.Enums.Exists(enumName)) return null;
            var e = _provider.Enums.Read(enumName);
            if (e == null) return null;

            var result = new EnumInfoModel { Name = e.Name, Label = Safe(() => e.Label), HelpText = Safe(() => e.HelpText) };
            try { result.IsExtensible = e.IsExtensible; } catch { }
            try { var mi = _provider.Enums.GetModelInfo(enumName); if (mi?.Count > 0) result.Model = mi.First().Name; } catch { }

            try
            {
                int idx = 0;
                foreach (var v in e.EnumValues)
                {
                    result.Values.Add(new EnumValueModel { Name = v.Name, Value = SafeInt(() => v.Value, idx), Label = Safe(() => v.Label) });
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
            if (!_provider.Edts.Exists(edtName)) return null;
            var edt = _provider.Edts.Read(edtName);
            if (edt == null) return null;

            var result = new EdtInfoModel
            {
                Name = edt.Name,
                BaseType = edt.GetType().Name.Replace("AxEdt", ""),
                Extends = Safe(() => edt.Extends),
                Label = Safe(() => edt.Label),
                HelpText = Safe(() => edt.HelpText),
            };

            try { var mi = _provider.Edts.GetModelInfo(edtName); if (mi?.Count > 0) result.Model = mi.First().Name; } catch { }
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
            if (!_provider.Forms.Exists(formName)) return null;
            var form = _provider.Forms.Read(formName);
            if (form == null) return null;

            var result = new FormInfoModel { Name = form.Name };
            try { var mi = _provider.Forms.GetModelInfo(formName); if (mi?.Count > 0) result.Model = mi.First().Name; } catch { }

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
            if (!_provider.Queries.Exists(queryName)) return null;
            var q = _provider.Queries.Read(queryName);
            if (q == null) return null;
            var result = new QueryInfoModel { Name = q.Name };
            try { var mi = _provider.Queries.GetModelInfo(queryName); if (mi?.Count > 0) result.Model = mi.First().Name; } catch { }
            try { result.Description = Safe(() => ((dynamic)q).Description); } catch { }
            try { dynamic dq = q; if (dq.DataSources != null) foreach (dynamic ds in dq.DataSources) result.DataSources.Add(MapQueryDataSource(ds)); } catch (Exception ex) { Warn("dataSources", queryName, ex); }
            return result;
        }

        public ViewInfoModel? ReadView(string viewName)
        {
            if (!_provider.Views.Exists(viewName)) return null;
            var v = _provider.Views.Read(viewName);
            if (v == null) return null;
            var result = new ViewInfoModel { Name = v.Name, Label = Safe(() => v.Label), Query = Safe(() => v.Query) };
            try { var mi = _provider.Views.GetModelInfo(viewName); if (mi?.Count > 0) result.Model = mi.First().Name; } catch { }

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
            if (!_provider.DataEntityViews.Exists(entityName)) return null;
            var e = _provider.DataEntityViews.Read(entityName);
            if (e == null) return null;
            var result = new DataEntityInfoModel { Name = e.Name, Label = Safe(() => e.Label), PublicEntityName = Safe(() => e.PublicEntityName), PublicCollectionName = Safe(() => e.PublicCollectionName), IsPublic = IsYes(() => e.IsPublic) };
            try { var mi = _provider.DataEntityViews.GetModelInfo(entityName); if (mi?.Count > 0) result.Model = mi.First().Name; } catch { }

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
                if (!_provider.Reports.Exists(reportName)) return null;
                var r = _provider.Reports.Read(reportName);
                if (r == null) return null;
                var result = new ReportInfoModel { Name = r.Name };
                try { var mi = _provider.Reports.GetModelInfo(reportName); if (mi?.Count > 0) result.Model = mi.First().Name; } catch { }

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
        // SEARCH / LIST
        // ========================
        public SearchResultModel SearchObjects(string type, string query, int maxResults)
        {
            var result = new SearchResultModel();
            void Search(string objType, IList<string> keys)
            {
                foreach (var n in keys)
                {
                    if (result.Results.Count >= maxResults) return;
                    if (n.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0)
                        result.Results.Add(new SearchItemModel { Name = n, Type = objType });
                }
            }

            try
            {
                switch (type.ToLowerInvariant())
                {
                    case "table": Search("table", _provider.Tables.GetPrimaryKeys()); break;
                    case "class": Search("class", _provider.Classes.GetPrimaryKeys()); break;
                    case "enum": Search("enum", _provider.Enums.GetPrimaryKeys()); break;
                    case "edt": Search("edt", _provider.Edts.GetPrimaryKeys()); break;
                    case "form": Search("form", _provider.Forms.GetPrimaryKeys()); break;
                    default:
                        Search("table", _provider.Tables.GetPrimaryKeys());
                        Search("class", _provider.Classes.GetPrimaryKeys());
                        Search("enum", _provider.Enums.GetPrimaryKeys());
                        Search("edt", _provider.Edts.GetPrimaryKeys());
                        Search("form", _provider.Forms.GetPrimaryKeys());
                        break;
                }
            }
            catch (Exception ex) { Console.Error.WriteLine($"[WARN] Search error: {ex.Message}"); }

            result.TotalCount = result.Results.Count;
            return result;
        }

        public object ListObjects(string type)
        {
            IList<string> keys = type.ToLowerInvariant() switch
            {
                "table" => _provider.Tables.GetPrimaryKeys(),
                "class" => _provider.Classes.GetPrimaryKeys(),
                "enum" => _provider.Enums.GetPrimaryKeys(),
                "edt" => _provider.Edts.GetPrimaryKeys(),
                "form" => _provider.Forms.GetPrimaryKeys(),
                "view" => _provider.Views.GetPrimaryKeys(),
                "query" => _provider.Queries.GetPrimaryKeys(),
                "dataentity" => _provider.DataEntityViews.GetPrimaryKeys(),
                _ => new List<string>()
            };
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
