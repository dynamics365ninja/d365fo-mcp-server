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
                default:
                    throw new ArgumentException($"replace-code not supported for objectType '{objectType}' via bridge");
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
        /// </summary>
        private void RemoveMethodIfExists(object axObject, string methodName)
        {
            try
            {
                // Both AxClass and AxTable expose Methods as a KeyedObjectCollection<AxMethod>
                dynamic dyn = axObject;
                var methods = dyn.Methods;
                AxMethod? toRemove = null;
                foreach (AxMethod m in methods)
                {
                    if (string.Equals(m.Name, methodName, StringComparison.OrdinalIgnoreCase))
                    {
                        toRemove = m;
                        break;
                    }
                }
                if (toRemove != null)
                {
                    // KeyedObjectCollection has Remove(T) or RemoveAt
                    methods.Remove(toRemove);
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WriteService] RemoveMethodIfExists failed: {ex.Message}");
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

                // Check declaration first (for classDeclaration scope)
                if (methodName == null || methodName.Equals("classDeclaration", StringComparison.OrdinalIgnoreCase))
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

                // Check methods
                foreach (AxMethod m in dyn.Methods)
                {
                    if (methodName != null && !string.Equals(m.Name, methodName, StringComparison.OrdinalIgnoreCase))
                        continue;

                    if (m.Source != null && m.Source.Contains(oldCode))
                    {
                        m.Source = m.Source.Replace(oldCode, newCode);
                        replaced = true;
                    }
                }

                return replaced;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WriteService] ReplaceInMethods failed: {ex.Message}");
                return false;
            }
        }

        // ========================
        // HELPERS: Model Info Resolution for Existing Objects
        // ========================

        /// <summary>
        /// Gets ModelSaveInfo for an existing object by asking the provider for its model info.
        /// </summary>
        private ModelSaveInfo GetModelSaveInfoForObject<T>(IReadOnlySingleKeyedMetadataProvider<T> collection, string objectName)
            where T : class
        {
            try
            {
                // GetModelInfo returns ModelInfoCollection which is IEnumerable<ModelInfo>
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
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WriteService] GetModelSaveInfoForObject failed for {objectName}: {ex.Message}");
            }

            throw new InvalidOperationException($"Cannot determine model for existing object '{objectName}'");
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
