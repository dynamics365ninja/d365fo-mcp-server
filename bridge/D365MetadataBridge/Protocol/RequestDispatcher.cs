using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using D365MetadataBridge.Services;
using D365MetadataBridge.Models;

namespace D365MetadataBridge.Protocol
{
    /// <summary>
    /// Routes incoming requests to the appropriate service method.
    /// </summary>
    public class RequestDispatcher
    {
        private readonly MetadataReadService? _metadataService;
        private readonly MetadataWriteService? _writeService;
        private readonly CrossReferenceService? _xrefService;

        public RequestDispatcher(MetadataReadService? metadataService, MetadataWriteService? writeService, CrossReferenceService? xrefService)
        {
            _metadataService = metadataService;
            _writeService = writeService;
            _xrefService = xrefService;
        }

        public Task<BridgeResponse> Dispatch(BridgeRequest request)
        {
            try
            {
                switch (request.Method.ToLowerInvariant())
                {
                    // === Health ===
                    case "ping":
                        return Task.FromResult(BridgeResponse.CreateSuccess(request.Id, "pong"));

                    // === Metadata Read ===
                    case "readtable":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("tableName")
                                ?? throw new ArgumentException("Missing parameter: tableName");
                            return _metadataService!.ReadTable(name);
                        });

                    case "readclass":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("className")
                                ?? throw new ArgumentException("Missing parameter: className");
                            return _metadataService!.ReadClass(name);
                        });

                    case "readenum":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("enumName")
                                ?? throw new ArgumentException("Missing parameter: enumName");
                            return _metadataService!.ReadEnum(name);
                        });

                    case "readedt":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("edtName")
                                ?? throw new ArgumentException("Missing parameter: edtName");
                            return _metadataService!.ReadEdt(name);
                        });

                    case "readform":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("formName")
                                ?? throw new ArgumentException("Missing parameter: formName");
                            return _metadataService!.ReadForm(name);
                        });

                    case "readquery":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("queryName")
                                ?? throw new ArgumentException("Missing parameter: queryName");
                            return _metadataService!.ReadQuery(name);
                        });

                    case "readview":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("viewName")
                                ?? throw new ArgumentException("Missing parameter: viewName");
                            return _metadataService!.ReadView(name);
                        });

                    case "readdataentity":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("entityName")
                                ?? throw new ArgumentException("Missing parameter: entityName");
                            return _metadataService!.ReadDataEntity(name);
                        });

                    case "readreport":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("reportName")
                                ?? throw new ArgumentException("Missing parameter: reportName");
                            return _metadataService!.ReadReport(name);
                        });

                    case "getmethodsource":
                        return HandleMetadata(request, () =>
                        {
                            var className = request.GetStringParam("className")
                                ?? throw new ArgumentException("Missing parameter: className");
                            var methodName = request.GetStringParam("methodName")
                                ?? throw new ArgumentException("Missing parameter: methodName");
                            return _metadataService!.GetMethodSource(className, methodName);
                        });

                    // === Search ===
                    case "searchobjects":
                        return HandleMetadata(request, () =>
                        {
                            var type = request.GetStringParam("type") ?? "all";
                            var query = request.GetStringParam("query")
                                ?? throw new ArgumentException("Missing parameter: query");
                            var maxResults = request.GetIntParam("maxResults") ?? 50;
                            return _metadataService!.SearchObjects(type, query, maxResults);
                        });

                    case "listobjects":
                        return HandleMetadata(request, () =>
                        {
                            var type = request.GetStringParam("type")
                                ?? throw new ArgumentException("Missing parameter: type");
                            return _metadataService!.ListObjects(type);
                        });

                    // === Security Artifacts (Phase 6) ===
                    case "readsecurityprivilege":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("name")
                                ?? throw new ArgumentException("Missing parameter: name");
                            return _metadataService!.ReadSecurityPrivilege(name);
                        });

                    case "readsecurityduty":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("name")
                                ?? throw new ArgumentException("Missing parameter: name");
                            return _metadataService!.ReadSecurityDuty(name);
                        });

                    case "readsecurityrole":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("name")
                                ?? throw new ArgumentException("Missing parameter: name");
                            return _metadataService!.ReadSecurityRole(name);
                        });

                    // === Menu Items (Phase 6) ===
                    case "readmenuitem":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("name")
                                ?? throw new ArgumentException("Missing parameter: name");
                            var itemType = request.GetStringParam("itemType") ?? "any";
                            return _metadataService!.ReadMenuItem(name, itemType);
                        });

                    // === Table Extensions (Phase 6) ===
                    case "readtableextensions":
                        return HandleMetadata(request, () =>
                        {
                            var baseTableName = request.GetStringParam("baseTableName")
                                ?? throw new ArgumentException("Missing parameter: baseTableName");
                            return _metadataService!.ReadTableExtensions(baseTableName);
                        });

                    // === Code Completion (Phase 6) ===
                    case "getcompletionmembers":
                        return HandleMetadata(request, () =>
                        {
                            var symbolName = request.GetStringParam("symbolName")
                                ?? throw new ArgumentException("Missing parameter: symbolName");
                            return _metadataService!.GetCompletionMembers(symbolName);
                        });

                    // === Cross-References ===
                    case "findreferences":
                        return HandleXref(request, () =>
                        {
                            var objectPath = request.GetStringParam("objectPath")
                                ?? request.GetStringParam("targetName")
                                ?? throw new ArgumentException("Missing parameter: objectPath or targetName");
                            return _xrefService!.FindReferences(objectPath);
                        });

                    case "getxrefschema":
                        return HandleXref(request, () =>
                        {
                            return _xrefService!.GetSchemaInfo();
                        });

                    case "samplexrefrows":
                        return HandleXref(request, () =>
                        {
                            var tableName = request.GetStringParam("tableName") ?? "References";
                            return _xrefService!.SampleRows(tableName);
                        });

                    // === Extension / Event xref queries (Phase 6) ===
                    case "findextensionclasses":
                        return HandleXref(request, () =>
                        {
                            var baseClassName = request.GetStringParam("baseClassName")
                                ?? throw new ArgumentException("Missing parameter: baseClassName");
                            return _xrefService!.FindExtensionClasses(baseClassName);
                        });

                    case "findeventsubscribers":
                        return HandleXref(request, () =>
                        {
                            var targetName = request.GetStringParam("targetName")
                                ?? throw new ArgumentException("Missing parameter: targetName");
                            return _xrefService!.FindEventSubscribers(targetName);
                        });

                    // === Delete ===
                    case "deleteobject":
                        return HandleMetadata(request, () =>
                        {
                            var objectType = request.GetStringParam("objectType")
                                ?? throw new ArgumentException("Missing parameter: objectType");
                            var objectName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing parameter: objectName");
                            return _metadataService!.DeleteObject(objectType, objectName);
                        });

                    // === Capabilities ===
                    case "getcapabilities":
                        return HandleMetadata(request, () =>
                        {
                            return _metadataService!.GetCapabilities();
                        });

                    // === Form Pattern Discovery ===
                    case "discoverformpatterns":
                        return HandleMetadata(request, () =>
                        {
                            return _metadataService!.DiscoverFormPatterns();
                        });

                    // === Info ===
                    case "getinfo":
                        return Task.FromResult(BridgeResponse.CreateSuccess(request.Id, new
                        {
                            version = "1.0.0",
                            metadataAvailable = _metadataService != null,
                            xrefAvailable = _xrefService != null,
                            writeAvailable = _writeService != null,
                            capabilities = new[]
                            {
                                "ping", "readTable", "readClass", "readEnum", "readEdt",
                                "readForm", "readQuery", "readView", "readDataEntity",
                                "readReport", "getMethodSource", "searchObjects",
                                "listObjects", "findReferences", "getInfo",
                                "validateObject", "resolveObjectInfo", "refreshProvider",
                                "createObject", "addMethod", "removeMethod", "addField",
                                "modifyField", "renameField", "removeField", "replaceAllFields",
                                "addIndex", "removeIndex", "addRelation", "removeRelation",
                                "addFieldGroup", "removeFieldGroup", "addFieldToFieldGroup",
                                "addEnumValue", "modifyEnumValue", "removeEnumValue",
                                "addControl", "addDataSource",
                                "setProperty", "replaceCode",
                                "deleteObject", "getCapabilities", "discoverFormPatterns"
                            }
                        }));

                    // === Write-support (validate / resolve / refresh) ===
                    case "validateobject":
                        return HandleMetadata(request, () =>
                        {
                            var objectType = request.GetStringParam("objectType")
                                ?? throw new ArgumentException("Missing parameter: objectType");
                            var objectName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing parameter: objectName");
                            return _metadataService!.ValidateObject(objectType, objectName);
                        });

                    case "resolveobjectinfo":
                        return HandleMetadata(request, () =>
                        {
                            var objectType = request.GetStringParam("objectType")
                                ?? throw new ArgumentException("Missing parameter: objectType");
                            var objectName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing parameter: objectName");
                            return _metadataService!.ResolveObjectInfo(objectType, objectName);
                        });

                    case "refreshprovider":
                        return HandleMetadata(request, () =>
                        {
                            return _metadataService!.RefreshProvider();
                        });

                    // === Write Operations (via MetadataWriteService) ===
                    case "createobject":
                        return HandleWrite(request, () =>
                        {
                            var objectType = request.GetStringParam("objectType")
                                ?? throw new ArgumentException("Missing: objectType");
                            var objectName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var modelName = request.GetStringParam("modelName")
                                ?? throw new ArgumentException("Missing: modelName");

                            switch (objectType.ToLowerInvariant())
                            {
                                case "class":
                                case "class-extension":
                                    return _writeService!.CreateClass(objectName, modelName,
                                        request.GetStringParam("declaration"),
                                        request.GetParam<System.Collections.Generic.List<WriteMethodParam>>("methods"),
                                        request.GetDictParam("properties"));

                                case "table":
                                    return _writeService!.CreateTable(objectName, modelName,
                                        request.GetParam<System.Collections.Generic.List<WriteFieldParam>>("fields"),
                                        request.GetParam<System.Collections.Generic.List<WriteFieldGroupParam>>("fieldGroups"),
                                        request.GetParam<System.Collections.Generic.List<WriteIndexParam>>("indexes"),
                                        request.GetParam<System.Collections.Generic.List<WriteRelationParam>>("relations"),
                                        request.GetParam<System.Collections.Generic.List<WriteMethodParam>>("methods"),
                                        request.GetDictParam("properties"));

                                case "enum":
                                    return _writeService!.CreateEnum(objectName, modelName,
                                        request.GetParam<System.Collections.Generic.List<WriteEnumValueParam>>("values"),
                                        request.GetDictParam("properties"));

                                case "edt":
                                    return _writeService!.CreateEdt(objectName, modelName,
                                        request.GetDictParam("properties"));

                                case "query":
                                    return _writeService!.CreateQuery(objectName, modelName,
                                        request.GetDictParam("properties"));

                                case "view":
                                    return _writeService!.CreateView(objectName, modelName,
                                        request.GetParam<System.Collections.Generic.List<WriteFieldParam>>("fields"),
                                        request.GetDictParam("properties"));

                                case "menu-item-action":
                                    return _writeService!.CreateMenuItemAction(objectName, modelName,
                                        request.GetDictParam("properties"));

                                case "menu-item-display":
                                    return _writeService!.CreateMenuItemDisplay(objectName, modelName,
                                        request.GetDictParam("properties"));

                                case "menu-item-output":
                                    return _writeService!.CreateMenuItemOutput(objectName, modelName,
                                        request.GetDictParam("properties"));

                                case "security-privilege":
                                    return _writeService!.CreateSecurityPrivilege(objectName, modelName,
                                        request.GetDictParam("properties"));

                                case "security-duty":
                                    return _writeService!.CreateSecurityDuty(objectName, modelName,
                                        request.GetDictParam("properties"));

                                case "security-role":
                                    return _writeService!.CreateSecurityRole(objectName, modelName,
                                        request.GetDictParam("properties"));

                                case "table-extension":
                                    return _writeService!.CreateTableExtension(objectName, modelName,
                                        request.GetParam<System.Collections.Generic.List<WriteFieldParam>>("fields"),
                                        request.GetParam<System.Collections.Generic.List<WriteFieldGroupParam>>("fieldGroups"),
                                        request.GetParam<System.Collections.Generic.List<WriteIndexParam>>("indexes"),
                                        request.GetParam<System.Collections.Generic.List<WriteRelationParam>>("relations"),
                                        request.GetParam<System.Collections.Generic.List<WriteMethodParam>>("methods"),
                                        request.GetDictParam("properties"));

                                case "form-extension":
                                    return _writeService!.CreateFormExtension(objectName, modelName,
                                        request.GetParam<System.Collections.Generic.List<WriteMethodParam>>("methods"),
                                        request.GetDictParam("properties"));

                                case "enum-extension":
                                    return _writeService!.CreateEnumExtension(objectName, modelName,
                                        request.GetParam<System.Collections.Generic.List<WriteEnumValueParam>>("values"),
                                        request.GetDictParam("properties"));

                                case "form":
                                    return _writeService!.CreateForm(objectName, modelName,
                                        request.GetParam<System.Collections.Generic.List<WriteMethodParam>>("methods"),
                                        request.GetDictParam("properties"));

                                case "menu":
                                    return _writeService!.CreateMenu(objectName, modelName,
                                        request.GetDictParam("properties"));

                                default:
                                    throw new ArgumentException($"createObject not supported for '{objectType}' via bridge — use XML fallback");
                            }
                        });

                    case "addmethod":
                        return HandleWrite(request, () =>
                        {
                            var objectType = request.GetStringParam("objectType")
                                ?? throw new ArgumentException("Missing: objectType");
                            var objectName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var methodName = request.GetStringParam("methodName")
                                ?? throw new ArgumentException("Missing: methodName");
                            var source = request.GetStringParam("sourceCode")
                                ?? throw new ArgumentException("Missing: sourceCode");
                            return _writeService!.AddMethod(objectType, objectName, methodName, source);
                        });

                    case "addfield":
                        return HandleWrite(request, () =>
                        {
                            var tableName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var fieldName = request.GetStringParam("fieldName")
                                ?? throw new ArgumentException("Missing: fieldName");
                            return _writeService!.AddField(tableName, fieldName,
                                request.GetStringParam("fieldType") ?? "String",
                                request.GetStringParam("edt"),
                                request.GetBoolParam("mandatory") ?? false,
                                request.GetStringParam("label"));
                        });

                    case "setproperty":
                        return HandleWrite(request, () =>
                        {
                            var objectType = request.GetStringParam("objectType")
                                ?? throw new ArgumentException("Missing: objectType");
                            var objectName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var propertyPath = request.GetStringParam("propertyPath")
                                ?? throw new ArgumentException("Missing: propertyPath");
                            var propertyValue = request.GetStringParam("propertyValue")
                                ?? throw new ArgumentException("Missing: propertyValue");
                            return _writeService!.SetProperty(objectType, objectName, propertyPath, propertyValue);
                        });

                    case "replacecode":
                        return HandleWrite(request, () =>
                        {
                            var objectType = request.GetStringParam("objectType")
                                ?? throw new ArgumentException("Missing: objectType");
                            var objectName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var oldCode = request.GetStringParam("oldCode")
                                ?? throw new ArgumentException("Missing: oldCode");
                            var newCode = request.GetStringParam("newCode")
                                ?? throw new ArgumentException("Missing: newCode");
                            return _writeService!.ReplaceCode(objectType, objectName,
                                request.GetStringParam("methodName"), oldCode, newCode);
                        });

                    case "removemethod":
                        return HandleWrite(request, () =>
                        {
                            var objectType = request.GetStringParam("objectType")
                                ?? throw new ArgumentException("Missing: objectType");
                            var objectName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var methodName = request.GetStringParam("methodName")
                                ?? throw new ArgumentException("Missing: methodName");
                            return _writeService!.RemoveMethod(objectType, objectName, methodName);
                        });

                    case "addindex":
                        return HandleWrite(request, () =>
                        {
                            var tableName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var indexName = request.GetStringParam("indexName")
                                ?? throw new ArgumentException("Missing: indexName");
                            return _writeService!.AddIndex(tableName, indexName,
                                request.GetParam<System.Collections.Generic.List<string>>("fields"),
                                request.GetBoolParam("allowDuplicates") ?? false,
                                request.GetBoolParam("alternateKey") ?? false);
                        });

                    case "removeindex":
                        return HandleWrite(request, () =>
                        {
                            var tableName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var indexName = request.GetStringParam("indexName")
                                ?? throw new ArgumentException("Missing: indexName");
                            return _writeService!.RemoveIndex(tableName, indexName);
                        });

                    case "addrelation":
                        return HandleWrite(request, () =>
                        {
                            var tableName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var relationName = request.GetStringParam("relationName")
                                ?? throw new ArgumentException("Missing: relationName");
                            var relatedTable = request.GetStringParam("relatedTable")
                                ?? throw new ArgumentException("Missing: relatedTable");
                            return _writeService!.AddRelation(tableName, relationName, relatedTable,
                                request.GetParam<System.Collections.Generic.List<WriteRelationConstraint>>("constraints"));
                        });

                    case "removerelation":
                        return HandleWrite(request, () =>
                        {
                            var tableName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var relationName = request.GetStringParam("relationName")
                                ?? throw new ArgumentException("Missing: relationName");
                            return _writeService!.RemoveRelation(tableName, relationName);
                        });

                    case "addfieldgroup":
                        return HandleWrite(request, () =>
                        {
                            var tableName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var groupName = request.GetStringParam("fieldGroupName")
                                ?? request.GetStringParam("groupName")
                                ?? throw new ArgumentException("Missing: fieldGroupName");
                            return _writeService!.AddFieldGroup(tableName, groupName,
                                request.GetStringParam("label"),
                                request.GetParam<System.Collections.Generic.List<string>>("fields"));
                        });

                    case "removefieldgroup":
                        return HandleWrite(request, () =>
                        {
                            var tableName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var groupName = request.GetStringParam("fieldGroupName")
                                ?? request.GetStringParam("groupName")
                                ?? throw new ArgumentException("Missing: fieldGroupName");
                            return _writeService!.RemoveFieldGroup(tableName, groupName);
                        });

                    case "addfieldtofieldgroup":
                        return HandleWrite(request, () =>
                        {
                            var tableName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var groupName = request.GetStringParam("fieldGroupName")
                                ?? request.GetStringParam("groupName")
                                ?? throw new ArgumentException("Missing: fieldGroupName");
                            var fieldName = request.GetStringParam("fieldName")
                                ?? throw new ArgumentException("Missing: fieldName");
                            return _writeService!.AddFieldToFieldGroup(tableName, groupName, fieldName);
                        });

                    case "modifyfield":
                        return HandleWrite(request, () =>
                        {
                            var tableName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var fieldName = request.GetStringParam("fieldName")
                                ?? throw new ArgumentException("Missing: fieldName");
                            return _writeService!.ModifyField(tableName, fieldName,
                                request.GetDictParam("properties"));
                        });

                    case "renamefield":
                        return HandleWrite(request, () =>
                        {
                            var tableName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var oldName = request.GetStringParam("fieldName")
                                ?? request.GetStringParam("oldName")
                                ?? throw new ArgumentException("Missing: fieldName");
                            var newName = request.GetStringParam("fieldNewName")
                                ?? request.GetStringParam("newName")
                                ?? throw new ArgumentException("Missing: fieldNewName");
                            return _writeService!.RenameField(tableName, oldName, newName);
                        });

                    case "removefield":
                        return HandleWrite(request, () =>
                        {
                            var tableName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var fieldName = request.GetStringParam("fieldName")
                                ?? throw new ArgumentException("Missing: fieldName");
                            return _writeService!.RemoveField(tableName, fieldName);
                        });

                    case "replaceallfields":
                        return HandleWrite(request, () =>
                        {
                            var tableName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var fields = request.GetParam<System.Collections.Generic.List<WriteFieldParam>>("fields")
                                ?? throw new ArgumentException("Missing: fields");
                            return _writeService!.ReplaceAllFields(tableName, fields);
                        });

                    case "addenumvalue":
                        return HandleWrite(request, () =>
                        {
                            var enumName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var valueName = request.GetStringParam("enumValueName")
                                ?? request.GetStringParam("valueName")
                                ?? throw new ArgumentException("Missing: enumValueName");
                            var value = request.GetIntParam("enumValue")
                                ?? request.GetIntParam("value")
                                ?? throw new ArgumentException("Missing: enumValue");
                            return _writeService!.AddEnumValue(enumName, valueName, value,
                                request.GetStringParam("label"));
                        });

                    case "modifyenumvalue":
                        return HandleWrite(request, () =>
                        {
                            var enumName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var valueName = request.GetStringParam("enumValueName")
                                ?? request.GetStringParam("valueName")
                                ?? throw new ArgumentException("Missing: enumValueName");
                            return _writeService!.ModifyEnumValue(enumName, valueName,
                                request.GetDictParam("properties"));
                        });

                    case "removeenumvalue":
                        return HandleWrite(request, () =>
                        {
                            var enumName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var valueName = request.GetStringParam("enumValueName")
                                ?? request.GetStringParam("valueName")
                                ?? throw new ArgumentException("Missing: enumValueName");
                            return _writeService!.RemoveEnumValue(enumName, valueName);
                        });

                    case "addcontrol":
                        return HandleWrite(request, () =>
                        {
                            var formName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var controlName = request.GetStringParam("controlName")
                                ?? throw new ArgumentException("Missing: controlName");
                            var parentControl = request.GetStringParam("parentControl")
                                ?? throw new ArgumentException("Missing: parentControl");
                            var controlType = request.GetStringParam("controlType") ?? "String";
                            return _writeService!.AddControl(formName, controlName, parentControl, controlType,
                                request.GetStringParam("controlDataSource"),
                                request.GetStringParam("controlDataField"),
                                request.GetStringParam("label"));
                        });

                    case "adddatasource":
                        return HandleWrite(request, () =>
                        {
                            var objectType = request.GetStringParam("objectType")
                                ?? throw new ArgumentException("Missing: objectType");
                            var objectName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var dsName = request.GetStringParam("dataSourceName")
                                ?? request.GetStringParam("dsName")
                                ?? throw new ArgumentException("Missing: dataSourceName");
                            var table = request.GetStringParam("dataSourceTable")
                                ?? request.GetStringParam("table")
                                ?? throw new ArgumentException("Missing: dataSourceTable");
                            return _writeService!.AddDataSource(objectType, objectName, dsName, table,
                                request.GetStringParam("joinSource"),
                                request.GetStringParam("linkType"));
                        });

                    case "addfieldmodification":
                        return HandleWrite(request, () =>
                        {
                            var objectName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            return _writeService!.AddFieldModification(objectName,
                                request.GetStringParam("fieldName")
                                    ?? throw new ArgumentException("Missing: fieldName"),
                                request.GetStringParam("fieldLabel") ?? request.GetStringParam("label"),
                                request.GetBoolParam("fieldMandatory") ?? request.GetBoolParam("mandatory"));
                        });

                    case "addmenuitemtomenu":
                        return HandleWrite(request, () =>
                        {
                            var objectName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            return _writeService!.AddMenuItemToMenu(objectName,
                                request.GetStringParam("menuItemToAdd")
                                    ?? request.GetStringParam("menuItemName")
                                    ?? throw new ArgumentException("Missing: menuItemToAdd"),
                                request.GetStringParam("menuItemToAddType")
                                    ?? request.GetStringParam("menuItemType")
                                    ?? "display");
                        });

                    // === Batch Modify (multiple operations in one call) ===
                    case "batchmodify":
                        return HandleBatchModify(request);

                    default:
                        return Task.FromResult(
                            BridgeResponse.CreateError(request.Id, -32601, $"Unknown method: {request.Method}"));
                }
            }
            catch (Exception ex)
            {
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32603, $"Dispatch error: {ex.Message}"));
            }
        }

        private Task<BridgeResponse> HandleMetadata(BridgeRequest request, Func<object?> handler)
        {
            if (_metadataService == null)
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32000, "Metadata service not available"));

            try
            {
                var result = handler();
                if (result == null)
                    return Task.FromResult(
                        BridgeResponse.CreateError(request.Id, -32001, "Object not found"));

                return Task.FromResult(BridgeResponse.CreateSuccess(request.Id, result));
            }
            catch (ArgumentException ex)
            {
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32602, ex.Message));
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[ERROR] {request.Method}: {ex.Message}\n{ex.StackTrace}");
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32603, $"Error in {request.Method}: {ex.Message}"));
            }
        }

        private Task<BridgeResponse> HandleWrite(BridgeRequest request, Func<object?> handler)
        {
            if (_writeService == null)
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32000, "Write service not available"));

            try
            {
                var result = handler();
                if (result == null)
                    return Task.FromResult(
                        BridgeResponse.CreateError(request.Id, -32001, "Write operation returned null"));

                return Task.FromResult(BridgeResponse.CreateSuccess(request.Id, result));
            }
            catch (ArgumentException ex)
            {
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32602, ex.Message));
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[ERROR] {request.Method}: {ex.Message}\n{ex.StackTrace}");
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32603, $"Error in {request.Method}: {ex.Message}"));
            }
        }

        private Task<BridgeResponse> HandleXref(BridgeRequest request, Func<object?> handler)
        {
            if (_xrefService == null)
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32000,
                        "Cross-reference service not available (DYNAMICSXREFDB not configured)"));

            try
            {
                var result = handler();
                return Task.FromResult(BridgeResponse.CreateSuccess(request.Id, result ?? new object()));
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[ERROR] {request.Method}: {ex.Message}\n{ex.StackTrace}");
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32603, $"Error in {request.Method}: {ex.Message}"));
            }
        }

        /// <summary>
        /// Handles batch modification: multiple write operations on one object in a single call.
        /// Each operation is executed independently — failures don't stop subsequent operations.
        /// </summary>
        private Task<BridgeResponse> HandleBatchModify(BridgeRequest request)
        {
            if (_writeService == null)
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32000, "Write service not available"));

            try
            {
                var objectType = request.GetStringParam("objectType")
                    ?? throw new ArgumentException("Missing: objectType");
                var objectName = request.GetStringParam("objectName")
                    ?? throw new ArgumentException("Missing: objectName");
                var operations = request.GetParam<System.Collections.Generic.List<D365MetadataBridge.Models.BatchOperationRequest>>("operations")
                    ?? throw new ArgumentException("Missing: operations array");

                var batchResult = new D365MetadataBridge.Models.BatchOperationResult
                {
                    ObjectType = objectType,
                    ObjectName = objectName,
                    TotalOperations = operations.Count,
                };

                foreach (var op in operations)
                {
                    var sw = System.Diagnostics.Stopwatch.StartNew();
                    var itemResult = new D365MetadataBridge.Models.BatchOperationItemResult
                    {
                        Operation = op.Operation,
                    };

                    try
                    {
                        object? writeResult = null;
                        var p = op.Params ?? new Dictionary<string, object>();

                        // Extract string helper
                        string? S(string key) => p.TryGetValue(key, out var v) ? v?.ToString() : null;
                        bool? B(string key) => p.TryGetValue(key, out var v) && v != null ? Convert.ToBoolean(v) : null;

                        switch (op.Operation.ToLowerInvariant())
                        {
                            case "addmethod":
                            case "add-method":
                                writeResult = _writeService.AddMethod(objectType, objectName,
                                    S("methodName") ?? throw new ArgumentException("Missing: methodName"),
                                    S("sourceCode") ?? throw new ArgumentException("Missing: sourceCode"));
                                break;

                            case "removemethod":
                            case "remove-method":
                                writeResult = _writeService.RemoveMethod(objectType, objectName,
                                    S("methodName") ?? throw new ArgumentException("Missing: methodName"));
                                break;

                            case "addfield":
                            case "add-field":
                                writeResult = _writeService.AddField(objectName,
                                    S("fieldName") ?? throw new ArgumentException("Missing: fieldName"),
                                    S("fieldType") ?? "String",
                                    S("edt"),
                                    B("mandatory") ?? false,
                                    S("label"));
                                break;

                            case "modifyfield":
                            case "modify-field":
                                writeResult = _writeService.ModifyField(objectName,
                                    S("fieldName") ?? throw new ArgumentException("Missing: fieldName"),
                                    p.Where(x => x.Key != "fieldName").ToDictionary(x => x.Key, x => x.Value?.ToString() ?? ""));
                                break;

                            case "renamefield":
                            case "rename-field":
                                writeResult = _writeService.RenameField(objectName,
                                    S("fieldName") ?? S("oldName") ?? throw new ArgumentException("Missing: fieldName"),
                                    S("fieldNewName") ?? S("newName") ?? throw new ArgumentException("Missing: fieldNewName"));
                                break;

                            case "removefield":
                            case "remove-field":
                                writeResult = _writeService.RemoveField(objectName,
                                    S("fieldName") ?? throw new ArgumentException("Missing: fieldName"));
                                break;

                            case "replaceallfields":
                            case "replace-all-fields":
                                {
                                    var fields = op.GetTypedParam<System.Collections.Generic.List<WriteFieldParam>>("fields")
                                        ?? throw new ArgumentException("Missing: fields");
                                    writeResult = _writeService.ReplaceAllFields(objectName, fields);
                                }
                                break;

                            case "addindex":
                            case "add-index":
                                writeResult = _writeService.AddIndex(objectName,
                                    S("indexName") ?? throw new ArgumentException("Missing: indexName"),
                                    op.GetTypedParam<System.Collections.Generic.List<string>>("fields"),
                                    B("allowDuplicates") ?? false,
                                    B("alternateKey") ?? false);
                                break;

                            case "removeindex":
                            case "remove-index":
                                writeResult = _writeService.RemoveIndex(objectName,
                                    S("indexName") ?? throw new ArgumentException("Missing: indexName"));
                                break;

                            case "addrelation":
                            case "add-relation":
                                writeResult = _writeService.AddRelation(objectName,
                                    S("relationName") ?? throw new ArgumentException("Missing: relationName"),
                                    S("relatedTable") ?? throw new ArgumentException("Missing: relatedTable"),
                                    op.GetTypedParam<System.Collections.Generic.List<WriteRelationConstraint>>("constraints"));
                                break;

                            case "removerelation":
                            case "remove-relation":
                                writeResult = _writeService.RemoveRelation(objectName,
                                    S("relationName") ?? throw new ArgumentException("Missing: relationName"));
                                break;

                            case "addfieldgroup":
                            case "add-field-group":
                                writeResult = _writeService.AddFieldGroup(objectName,
                                    S("fieldGroupName") ?? S("groupName") ?? throw new ArgumentException("Missing: fieldGroupName"),
                                    S("label"),
                                    op.GetTypedParam<System.Collections.Generic.List<string>>("fields"));
                                break;

                            case "removefieldgroup":
                            case "remove-field-group":
                                writeResult = _writeService.RemoveFieldGroup(objectName,
                                    S("fieldGroupName") ?? S("groupName") ?? throw new ArgumentException("Missing: fieldGroupName"));
                                break;

                            case "addfieldtofieldgroup":
                            case "add-field-to-field-group":
                                writeResult = _writeService.AddFieldToFieldGroup(objectName,
                                    S("fieldGroupName") ?? S("groupName") ?? throw new ArgumentException("Missing: fieldGroupName"),
                                    S("fieldName") ?? throw new ArgumentException("Missing: fieldName"));
                                break;

                            case "addenumvalue":
                            case "add-enum-value":
                                {
                                    int enumVal = 0;
                                    if (p.TryGetValue("enumValue", out var ev) || p.TryGetValue("value", out ev))
                                        int.TryParse(ev?.ToString(), out enumVal);
                                    writeResult = _writeService.AddEnumValue(objectName,
                                        S("enumValueName") ?? S("valueName") ?? throw new ArgumentException("Missing: enumValueName"),
                                        enumVal, S("label"));
                                }
                                break;

                            case "modifyenumvalue":
                            case "modify-enum-value":
                                writeResult = _writeService.ModifyEnumValue(objectName,
                                    S("enumValueName") ?? S("valueName") ?? throw new ArgumentException("Missing: enumValueName"),
                                    p.Where(x => x.Key != "enumValueName" && x.Key != "valueName")
                                     .ToDictionary(x => x.Key, x => x.Value?.ToString() ?? ""));
                                break;

                            case "removeenumvalue":
                            case "remove-enum-value":
                                writeResult = _writeService.RemoveEnumValue(objectName,
                                    S("enumValueName") ?? S("valueName") ?? throw new ArgumentException("Missing: enumValueName"));
                                break;

                            case "addcontrol":
                            case "add-control":
                                writeResult = _writeService.AddControl(objectName,
                                    S("controlName") ?? throw new ArgumentException("Missing: controlName"),
                                    S("parentControl") ?? throw new ArgumentException("Missing: parentControl"),
                                    S("controlType") ?? "String",
                                    S("controlDataSource"), S("controlDataField"), S("label"));
                                break;

                            case "adddatasource":
                            case "add-data-source":
                                writeResult = _writeService.AddDataSource(objectType, objectName,
                                    S("dataSourceName") ?? S("dsName") ?? throw new ArgumentException("Missing: dataSourceName"),
                                    S("dataSourceTable") ?? S("table") ?? throw new ArgumentException("Missing: dataSourceTable"),
                                    S("joinSource"), S("linkType"));
                                break;

                            case "setproperty":
                            case "set-property":
                            case "modify-property":
                                writeResult = _writeService.SetProperty(objectType, objectName,
                                    S("propertyPath") ?? throw new ArgumentException("Missing: propertyPath"),
                                    S("propertyValue") ?? throw new ArgumentException("Missing: propertyValue"));
                                break;

                            case "replacecode":
                            case "replace-code":
                                writeResult = _writeService.ReplaceCode(objectType, objectName,
                                    S("methodName"),
                                    S("oldCode") ?? throw new ArgumentException("Missing: oldCode"),
                                    S("newCode") ?? throw new ArgumentException("Missing: newCode"));
                                break;

                            case "addfieldmodification":
                            case "add-field-modification":
                                writeResult = _writeService.AddFieldModification(objectName,
                                    S("fieldName") ?? throw new ArgumentException("Missing: fieldName"),
                                    S("fieldLabel") ?? S("label"),
                                    B("fieldMandatory") ?? B("mandatory"));
                                break;

                            case "addmenuitemtomenu":
                            case "add-menu-item-to-menu":
                                writeResult = _writeService.AddMenuItemToMenu(objectName,
                                    S("menuItemToAdd") ?? S("menuItemName") ?? throw new ArgumentException("Missing: menuItemToAdd"),
                                    S("menuItemToAddType") ?? S("menuItemType") ?? "display");
                                break;

                            default:
                                throw new ArgumentException($"Unsupported batch operation: {op.Operation}");
                        }

                        itemResult.Success = true;
                        batchResult.SuccessCount++;
                    }
                    catch (Exception ex)
                    {
                        itemResult.Success = false;
                        itemResult.Error = ex.Message;
                        batchResult.FailureCount++;
                        Console.Error.WriteLine($"[BATCH] Operation '{op.Operation}' failed: {ex.Message}");
                    }

                    sw.Stop();
                    itemResult.ElapsedMs = sw.ElapsedMilliseconds;
                    batchResult.Operations.Add(itemResult);
                }

                return Task.FromResult(BridgeResponse.CreateSuccess(request.Id, batchResult));
            }
            catch (ArgumentException ex)
            {
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32602, ex.Message));
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[ERROR] batchModify: {ex.Message}\n{ex.StackTrace}");
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32603, $"Error in batchModify: {ex.Message}"));
            }
        }
    }
}
