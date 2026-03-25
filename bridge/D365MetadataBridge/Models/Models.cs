using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace D365MetadataBridge.Models
{
    // ========================
    // Table models
    // ========================

    public class TableInfoModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("label")]
        public string? Label { get; set; }

        [JsonPropertyName("developerDocumentation")]
        public string? DeveloperDocumentation { get; set; }

        [JsonPropertyName("tableGroup")]
        public string? TableGroup { get; set; }

        [JsonPropertyName("tabletype")]
        public string? TableType { get; set; }

        [JsonPropertyName("cacheLookup")]
        public string? CacheLookup { get; set; }

        [JsonPropertyName("clusteredIndex")]
        public string? ClusteredIndex { get; set; }

        [JsonPropertyName("primaryIndex")]
        public string? PrimaryIndex { get; set; }

        [JsonPropertyName("saveDataPerCompany")]
        public string? SaveDataPerCompany { get; set; }

        [JsonPropertyName("extends")]
        public string? Extends { get; set; }

        [JsonPropertyName("supportInheritance")]
        public string? SupportInheritance { get; set; }

        [JsonPropertyName("model")]
        public string? Model { get; set; }

        [JsonPropertyName("fields")]
        public List<FieldInfoModel> Fields { get; set; } = new List<FieldInfoModel>();

        [JsonPropertyName("fieldGroups")]
        public List<FieldGroupModel> FieldGroups { get; set; } = new List<FieldGroupModel>();

        [JsonPropertyName("indexes")]
        public List<IndexInfoModel> Indexes { get; set; } = new List<IndexInfoModel>();

        [JsonPropertyName("relations")]
        public List<RelationInfoModel> Relations { get; set; } = new List<RelationInfoModel>();

        [JsonPropertyName("methods")]
        public List<MethodInfoModel> Methods { get; set; } = new List<MethodInfoModel>();
    }

    public class FieldInfoModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("fieldType")]
        public string FieldType { get; set; } = "";

        [JsonPropertyName("extendedDataType")]
        public string? ExtendedDataType { get; set; }

        [JsonPropertyName("enumType")]
        public string? EnumType { get; set; }

        [JsonPropertyName("label")]
        public string? Label { get; set; }

        [JsonPropertyName("helpText")]
        public string? HelpText { get; set; }

        [JsonPropertyName("mandatory")]
        public bool Mandatory { get; set; }

        [JsonPropertyName("allowEdit")]
        public string? AllowEdit { get; set; }

        [JsonPropertyName("stringSize")]
        public int? StringSize { get; set; }
    }

    public class FieldGroupModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("label")]
        public string? Label { get; set; }

        [JsonPropertyName("fields")]
        public List<string> Fields { get; set; } = new List<string>();
    }

    public class IndexInfoModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("allowDuplicates")]
        public bool AllowDuplicates { get; set; }

        [JsonPropertyName("alternateKey")]
        public bool AlternateKey { get; set; }

        [JsonPropertyName("fields")]
        public List<IndexFieldModel> Fields { get; set; } = new List<IndexFieldModel>();
    }

    public class IndexFieldModel
    {
        [JsonPropertyName("dataField")]
        public string DataField { get; set; } = "";

        [JsonPropertyName("includedColumn")]
        public bool IncludedColumn { get; set; }
    }

    public class RelationInfoModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("relatedTable")]
        public string RelatedTable { get; set; } = "";

        [JsonPropertyName("cardinality")]
        public string? Cardinality { get; set; }

        [JsonPropertyName("relatedTableCardinality")]
        public string? RelatedTableCardinality { get; set; }

        [JsonPropertyName("constraints")]
        public List<RelationConstraintModel> Constraints { get; set; } = new List<RelationConstraintModel>();
    }

    public class RelationConstraintModel
    {
        [JsonPropertyName("field")]
        public string? Field { get; set; }

        [JsonPropertyName("relatedField")]
        public string? RelatedField { get; set; }

        [JsonPropertyName("value")]
        public string? Value { get; set; }
    }

    // ========================
    // Class models
    // ========================

    public class ClassInfoModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("extends")]
        public string? Extends { get; set; }

        [JsonPropertyName("isAbstract")]
        public bool IsAbstract { get; set; }

        [JsonPropertyName("isFinal")]
        public bool IsFinal { get; set; }

        [JsonPropertyName("isStatic")]
        public bool IsStatic { get; set; }

        [JsonPropertyName("model")]
        public string? Model { get; set; }

        [JsonPropertyName("declaration")]
        public string? Declaration { get; set; }

        [JsonPropertyName("methods")]
        public List<MethodInfoModel> Methods { get; set; } = new List<MethodInfoModel>();
    }

    public class MethodInfoModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("source")]
        public string? Source { get; set; }

        [JsonPropertyName("isStatic")]
        public bool IsStatic { get; set; }
    }

    // ========================
    // Enum models
    // ========================

    public class EnumInfoModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("label")]
        public string? Label { get; set; }

        [JsonPropertyName("helpText")]
        public string? HelpText { get; set; }

        [JsonPropertyName("isExtensible")]
        public bool IsExtensible { get; set; }

        [JsonPropertyName("model")]
        public string? Model { get; set; }

        [JsonPropertyName("values")]
        public List<EnumValueModel> Values { get; set; } = new List<EnumValueModel>();
    }

    public class EnumValueModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("value")]
        public int Value { get; set; }

        [JsonPropertyName("label")]
        public string? Label { get; set; }
    }

    // ========================
    // EDT models
    // ========================

    public class EdtInfoModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("baseType")]
        public string BaseType { get; set; } = "";

        [JsonPropertyName("extends")]
        public string? Extends { get; set; }

        [JsonPropertyName("label")]
        public string? Label { get; set; }

        [JsonPropertyName("helpText")]
        public string? HelpText { get; set; }

        [JsonPropertyName("stringSize")]
        public int? StringSize { get; set; }

        [JsonPropertyName("referenceTable")]
        public string? ReferenceTable { get; set; }

        [JsonPropertyName("enumType")]
        public string? EnumType { get; set; }

        [JsonPropertyName("model")]
        public string? Model { get; set; }

        // --- New gap-fill properties ---

        [JsonPropertyName("formHelp")]
        public string? FormHelp { get; set; }

        [JsonPropertyName("configurationKey")]
        public string? ConfigurationKey { get; set; }

        [JsonPropertyName("alignment")]
        public string? Alignment { get; set; }

        [JsonPropertyName("displayLength")]
        public int? DisplayLength { get; set; }

        [JsonPropertyName("relationType")]
        public string? RelationType { get; set; }

        // AxEdtReal specific
        [JsonPropertyName("noOfDecimals")]
        public int? NoOfDecimals { get; set; }

        [JsonPropertyName("decimalSeparator")]
        public string? DecimalSeparator { get; set; }

        [JsonPropertyName("signDisplay")]
        public string? SignDisplay { get; set; }
    }

    // ========================
    // Form models
    // ========================

    public class FormInfoModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("formPattern")]
        public string? FormPattern { get; set; }

        [JsonPropertyName("model")]
        public string? Model { get; set; }

        [JsonPropertyName("dataSources")]
        public List<FormDataSourceModel> DataSources { get; set; } = new List<FormDataSourceModel>();

        [JsonPropertyName("controls")]
        public List<FormControlModel> Controls { get; set; } = new List<FormControlModel>();

        [JsonPropertyName("methods")]
        public List<MethodInfoModel> Methods { get; set; } = new List<MethodInfoModel>();
    }

    public class FormDataSourceModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("table")]
        public string Table { get; set; } = "";

        [JsonPropertyName("joinSource")]
        public string? JoinSource { get; set; }

        [JsonPropertyName("linkType")]
        public string? LinkType { get; set; }

        // --- New gap-fill properties ---

        [JsonPropertyName("allowEdit")]
        public string? AllowEdit { get; set; }

        [JsonPropertyName("allowCreate")]
        public string? AllowCreate { get; set; }

        [JsonPropertyName("allowDelete")]
        public string? AllowDelete { get; set; }
    }

    public class FormControlModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("controlType")]
        public string ControlType { get; set; } = "";

        [JsonPropertyName("dataSource")]
        public string? DataSource { get; set; }

        [JsonPropertyName("dataField")]
        public string? DataField { get; set; }

        [JsonPropertyName("children")]
        public List<FormControlModel>? Children { get; set; }

        // --- New gap-fill properties ---

        [JsonPropertyName("caption")]
        public string? Caption { get; set; }

        [JsonPropertyName("label")]
        public string? Label { get; set; }

        [JsonPropertyName("helpText")]
        public string? HelpText { get; set; }

        [JsonPropertyName("visible")]
        public string? Visible { get; set; }

        [JsonPropertyName("enabled")]
        public string? Enabled { get; set; }

        [JsonPropertyName("dataMethod")]
        public string? DataMethod { get; set; }

        [JsonPropertyName("autoDeclaration")]
        public string? AutoDeclaration { get; set; }
    }

    // ========================
    // Query / View / DataEntity models
    // ========================

    public class QueryInfoModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("model")]
        public string? Model { get; set; }

        [JsonPropertyName("description")]
        public string? Description { get; set; }

        [JsonPropertyName("dataSources")]
        public List<QueryDataSourceModel> DataSources { get; set; } = new List<QueryDataSourceModel>();
    }

    public class QueryDataSourceModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("table")]
        public string Table { get; set; } = "";

        [JsonPropertyName("joinMode")]
        public string? JoinMode { get; set; }

        [JsonPropertyName("fetchMode")]
        public string? FetchMode { get; set; }

        [JsonPropertyName("childDataSources")]
        public List<QueryDataSourceModel>? ChildDataSources { get; set; }

        [JsonPropertyName("ranges")]
        public List<QueryRangeModel>? Ranges { get; set; }

        [JsonPropertyName("fields")]
        public List<string>? Fields { get; set; }
    }

    public class QueryRangeModel
    {
        [JsonPropertyName("field")]
        public string Field { get; set; } = "";

        [JsonPropertyName("value")]
        public string? Value { get; set; }

        [JsonPropertyName("status")]
        public string? Status { get; set; }
    }

    public class ViewInfoModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("label")]
        public string? Label { get; set; }

        [JsonPropertyName("model")]
        public string? Model { get; set; }

        [JsonPropertyName("query")]
        public string? Query { get; set; }

        [JsonPropertyName("isPublic")]
        public bool IsPublic { get; set; }

        [JsonPropertyName("isReadOnly")]
        public bool IsReadOnly { get; set; }

        [JsonPropertyName("primaryKey")]
        public string? PrimaryKey { get; set; }

        [JsonPropertyName("fields")]
        public List<ViewFieldModel> Fields { get; set; } = new List<ViewFieldModel>();

        [JsonPropertyName("relations")]
        public List<RelationInfoModel> Relations { get; set; } = new List<RelationInfoModel>();

        [JsonPropertyName("methods")]
        public List<MethodInfoModel> Methods { get; set; } = new List<MethodInfoModel>();

        [JsonPropertyName("dataSources")]
        public List<FormDataSourceModel> DataSources { get; set; } = new List<FormDataSourceModel>();
    }

    public class ViewFieldModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("fieldType")]
        public string FieldType { get; set; } = "";

        [JsonPropertyName("dataSource")]
        public string? DataSource { get; set; }

        [JsonPropertyName("dataField")]
        public string? DataField { get; set; }

        [JsonPropertyName("dataMethod")]
        public string? DataMethod { get; set; }

        [JsonPropertyName("label")]
        public string? Label { get; set; }

        [JsonPropertyName("isComputed")]
        public bool IsComputed { get; set; }
    }

    public class DataEntityInfoModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("label")]
        public string? Label { get; set; }

        [JsonPropertyName("publicEntityName")]
        public string? PublicEntityName { get; set; }

        [JsonPropertyName("publicCollectionName")]
        public string? PublicCollectionName { get; set; }

        [JsonPropertyName("isPublic")]
        public bool IsPublic { get; set; }

        [JsonPropertyName("model")]
        public string? Model { get; set; }

        [JsonPropertyName("dataSources")]
        public List<FormDataSourceModel> DataSources { get; set; } = new List<FormDataSourceModel>();

        [JsonPropertyName("fields")]
        public List<FieldInfoModel> Fields { get; set; } = new List<FieldInfoModel>();

        // --- New gap-fill properties ---

        [JsonPropertyName("isReadOnly")]
        public bool IsReadOnly { get; set; }

        [JsonPropertyName("entityCategory")]
        public string? EntityCategory { get; set; }

        [JsonPropertyName("dataManagementEnabled")]
        public bool DataManagementEnabled { get; set; }

        [JsonPropertyName("stagingTable")]
        public string? StagingTable { get; set; }

        [JsonPropertyName("keys")]
        public List<IndexInfoModel> Keys { get; set; } = new List<IndexInfoModel>();

        [JsonPropertyName("fieldMappings")]
        public List<DataEntityFieldMappingModel> FieldMappings { get; set; } = new List<DataEntityFieldMappingModel>();

        [JsonPropertyName("computedColumns")]
        public List<string> ComputedColumns { get; set; } = new List<string>();
    }

    public class DataEntityFieldMappingModel
    {
        [JsonPropertyName("fieldName")]
        public string FieldName { get; set; } = "";

        [JsonPropertyName("dataSource")]
        public string? DataSource { get; set; }

        [JsonPropertyName("dataField")]
        public string? DataField { get; set; }
    }

    public class ReportInfoModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("model")]
        public string? Model { get; set; }

        [JsonPropertyName("dataSets")]
        public List<ReportDataSetModel> DataSets { get; set; } = new List<ReportDataSetModel>();

        [JsonPropertyName("designs")]
        public List<ReportDesignModel> Designs { get; set; } = new List<ReportDesignModel>();
    }

    public class ReportDataSetModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("dataSourceType")]
        public string? DataSourceType { get; set; }

        [JsonPropertyName("query")]
        public string? Query { get; set; }

        [JsonPropertyName("fields")]
        public List<ReportDataSetFieldModel> Fields { get; set; } = new List<ReportDataSetFieldModel>();
    }

    public class ReportDataSetFieldModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("dataField")]
        public string? DataField { get; set; }

        [JsonPropertyName("dataType")]
        public string? DataType { get; set; }
    }

    public class ReportDesignModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("caption")]
        public string? Caption { get; set; }

        [JsonPropertyName("style")]
        public string? Style { get; set; }

        [JsonPropertyName("hasRdl")]
        public bool HasRdl { get; set; }
    }

    // ========================
    // Cross-reference models
    // ========================

    public class ReferenceInfoModel
    {
        [JsonPropertyName("sourcePath")]
        public string SourcePath { get; set; } = "";

        [JsonPropertyName("sourceModule")]
        public string? SourceModule { get; set; }

        [JsonPropertyName("kind")]
        public string? Kind { get; set; }

        [JsonPropertyName("line")]
        public int Line { get; set; }

        [JsonPropertyName("column")]
        public int Column { get; set; }

        /// <summary>Categorized reference type: call, extends, implements, field-access, type-reference</summary>
        [JsonPropertyName("referenceType")]
        public string? ReferenceType { get; set; }

        /// <summary>Source class name parsed from SourcePath (e.g. "SalesFormLetter" from "/Classes/SalesFormLetter/Methods/run")</summary>
        [JsonPropertyName("callerClass")]
        public string? CallerClass { get; set; }

        /// <summary>Source method name parsed from SourcePath (e.g. "run" from "/Classes/SalesFormLetter/Methods/run")</summary>
        [JsonPropertyName("callerMethod")]
        public string? CallerMethod { get; set; }
    }

    /// <summary>
    /// Enriched extension class result with method-level CoC detail.
    /// </summary>
    public class ExtensionClassDetailModel
    {
        [JsonPropertyName("className")]
        public string ClassName { get; set; } = "";

        [JsonPropertyName("module")]
        public string? Module { get; set; }

        /// <summary>Methods that the extension class wraps via CoC (next calls)</summary>
        [JsonPropertyName("wrappedMethods")]
        public List<string> WrappedMethods { get; set; } = new List<string>();
    }

    /// <summary>
    /// Enriched event subscriber result with handler type categorization.
    /// </summary>
    public class EventSubscriberDetailModel
    {
        [JsonPropertyName("className")]
        public string ClassName { get; set; } = "";

        [JsonPropertyName("module")]
        public string? Module { get; set; }

        [JsonPropertyName("methodName")]
        public string? MethodName { get; set; }

        /// <summary>Event name (e.g. "onInserted", "onValidatedWrite")</summary>
        [JsonPropertyName("eventName")]
        public string? EventName { get; set; }

        /// <summary>Handler type: "dataEvent", "delegate", "pre", "post"</summary>
        [JsonPropertyName("handlerType")]
        public string? HandlerType { get; set; }
    }

    /// <summary>
    /// API usage caller information from cross-reference database.
    /// </summary>
    public class ApiUsageCallerModel
    {
        [JsonPropertyName("callerClass")]
        public string CallerClass { get; set; } = "";

        [JsonPropertyName("callerMethod")]
        public string? CallerMethod { get; set; }

        [JsonPropertyName("module")]
        public string? Module { get; set; }

        [JsonPropertyName("kind")]
        public string? Kind { get; set; }

        [JsonPropertyName("line")]
        public int Line { get; set; }
    }

    // ========================
    // Search models
    // ========================

    public class SearchResultModel
    {
        [JsonPropertyName("results")]
        public List<SearchItemModel> Results { get; set; } = new List<SearchItemModel>();

        [JsonPropertyName("totalCount")]
        public int TotalCount { get; set; }
    }

    public class SearchItemModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("type")]
        public string Type { get; set; } = "";

        [JsonPropertyName("model")]
        public string? Model { get; set; }
    }

    public class MethodSourceModel
    {
        [JsonPropertyName("className")]
        public string ClassName { get; set; } = "";

        [JsonPropertyName("methodName")]
        public string MethodName { get; set; } = "";

        [JsonPropertyName("source")]
        public string? Source { get; set; }

        [JsonPropertyName("found")]
        public bool Found { get; set; }
    }

    // ========================
    // Delete result model
    // ========================

    public class DeleteResultModel
    {
        [JsonPropertyName("success")]
        public bool Success { get; set; }

        [JsonPropertyName("objectType")]
        public string ObjectType { get; set; } = "";

        [JsonPropertyName("objectName")]
        public string ObjectName { get; set; } = "";

        [JsonPropertyName("model")]
        public string? Model { get; set; }

        [JsonPropertyName("filePath")]
        public string? FilePath { get; set; }

        [JsonPropertyName("error")]
        public string? Error { get; set; }
    }

    // ========================
    // Batch operation models
    // ========================

    public class BatchOperationRequest
    {
        [JsonPropertyName("operation")]
        public string Operation { get; set; } = "";

        [JsonPropertyName("params")]
        public Dictionary<string, object>? Params { get; set; }

        /// <summary>
        /// Deserializes a typed parameter from the Params dictionary.
        /// Values arrive as JsonElement from System.Text.Json — convert to the target type.
        /// </summary>
        public T? GetTypedParam<T>(string key) where T : class
        {
            if (Params == null || !Params.TryGetValue(key, out var raw) || raw == null)
                return null;
            try
            {
                if (raw is System.Text.Json.JsonElement je)
                    return System.Text.Json.JsonSerializer.Deserialize<T>(je.GetRawText());
                // Already correct type
                if (raw is T typed) return typed;
                // Fallback: serialize then deserialize
                var json = System.Text.Json.JsonSerializer.Serialize(raw);
                return System.Text.Json.JsonSerializer.Deserialize<T>(json);
            }
            catch { return null; }
        }
    }

    public class BatchOperationResult
    {
        [JsonPropertyName("objectType")]
        public string ObjectType { get; set; } = "";

        [JsonPropertyName("objectName")]
        public string ObjectName { get; set; } = "";

        [JsonPropertyName("totalOperations")]
        public int TotalOperations { get; set; }

        [JsonPropertyName("successCount")]
        public int SuccessCount { get; set; }

        [JsonPropertyName("failureCount")]
        public int FailureCount { get; set; }

        [JsonPropertyName("operations")]
        public List<BatchOperationItemResult> Operations { get; set; } = new List<BatchOperationItemResult>();
    }

    public class BatchOperationItemResult
    {
        [JsonPropertyName("operation")]
        public string Operation { get; set; } = "";

        [JsonPropertyName("success")]
        public bool Success { get; set; }

        [JsonPropertyName("error")]
        public string? Error { get; set; }

        [JsonPropertyName("elapsedMs")]
        public long ElapsedMs { get; set; }
    }

    // ========================
    // Capabilities model
    // ========================

    public class CapabilitiesModel
    {
        [JsonPropertyName("objectTypes")]
        public Dictionary<string, List<string>> ObjectTypes { get; set; } = new Dictionary<string, List<string>>();

        [JsonPropertyName("version")]
        public string Version { get; set; } = "1.0.0";
    }

    // ========================
    // Form pattern discovery models
    // ========================

    public class FormPatternModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("version")]
        public string? Version { get; set; }

        [JsonPropertyName("description")]
        public string? Description { get; set; }
    }

    public class FormPatternDiscoveryResult
    {
        [JsonPropertyName("patterns")]
        public List<FormPatternModel> Patterns { get; set; } = new List<FormPatternModel>();

        [JsonPropertyName("count")]
        public int Count { get; set; }

        [JsonPropertyName("source")]
        public string Source { get; set; } = "";
    }
}
