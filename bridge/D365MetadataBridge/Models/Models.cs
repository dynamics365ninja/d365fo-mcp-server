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

        [JsonPropertyName("childDataSources")]
        public List<QueryDataSourceModel>? ChildDataSources { get; set; }
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

        [JsonPropertyName("fields")]
        public List<FieldInfoModel> Fields { get; set; } = new List<FieldInfoModel>();
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
    }

    public class ReportInfoModel
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("model")]
        public string? Model { get; set; }

        [JsonPropertyName("dataSets")]
        public List<string> DataSets { get; set; } = new List<string>();
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
}
