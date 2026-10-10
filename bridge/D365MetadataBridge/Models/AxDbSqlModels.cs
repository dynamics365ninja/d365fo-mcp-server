using System;
using System.Collections.Generic;
using System.Data;
using System.Data.SqlClient;
using System.Data.SqlTypes;
using System.Globalization;
using System.Text.Json;

namespace D365MetadataBridge.Models
{
    public sealed class AxDbSqlOptions
    {
        public string Server { get; set; } = "";
        public string Database { get; set; } = "AxDB";
        public bool TrustCertificate { get; set; }
        public int TimeoutSeconds { get; set; } = 30;
        public int MaxRows { get; set; } = 100;
        public bool Enabled => !string.IsNullOrWhiteSpace(Server);

        public string ConnectionString()
        {
            if (!Enabled) throw new ArgumentException("AxDB SQL server is not configured.");
            if (string.IsNullOrWhiteSpace(Database) || TimeoutSeconds < 1 || TimeoutSeconds > 30 || MaxRows < 1 || MaxRows > 1000)
                throw new ArgumentException("Invalid AxDB SQL configuration: database required, timeout 1..30, max rows 1..1000.");
            return new SqlConnectionStringBuilder
            {
                DataSource = Server, InitialCatalog = Database, IntegratedSecurity = true,
                Encrypt = true, TrustServerCertificate = TrustCertificate, ConnectTimeout = TimeoutSeconds,
                ApplicationName = "D365MetadataBridge AxDB debug", Pooling = false, ConnectRetryCount = 0
            }.ConnectionString;
        }
    }

    public sealed class AxDbSqlRequest
    {
        public string Sql { get; set; } = "";
        public List<AxDbSqlParameter>? Parameters { get; set; }
        public int? MaxRows { get; set; }
        public string Table { get; set; } = "";
        public string Schema { get; set; } = "dbo";
    }

    public sealed class AxDbSqlParameter
    {
        public string Name { get; set; } = "";
        public string Type { get; set; } = "";
        public JsonElement Value { get; set; }
        public int? Size { get; set; }
        public byte? Precision { get; set; }
        public byte? Scale { get; set; }

        public SqlParameter ToSqlParameter()
        {
            if (Name.Length < 1 || Name.Length > 128 || !(AsciiLetter(Name[0]) || Name[0] == '_'))
                throw new ArgumentException("Parameter name must start with a letter or underscore, without @.");
            for (var i = 1; i < Name.Length; i++)
                if (!(AsciiLetter(Name[i]) || (Name[i] >= '0' && Name[i] <= '9') || Name[i] == '_')) throw new ArgumentException("Invalid SQL parameter name.");
            if (Value.ValueKind == JsonValueKind.Undefined) throw new ArgumentException("Parameter value is required (use null for SQL NULL).");
            var isNull = Value.ValueKind == JsonValueKind.Null;
            var parameter = new SqlParameter { ParameterName = "@" + Name };
            object value = DBNull.Value;
            switch (Type.ToLowerInvariant())
            {
                case "bit":
                    parameter.SqlDbType = SqlDbType.Bit;
                    if (!isNull) value = Value.GetBoolean();
                    break;
                case "int":
                    parameter.SqlDbType = SqlDbType.Int;
                    if (!isNull) value = Value.GetInt32();
                    break;
                case "bigint":
                    parameter.SqlDbType = SqlDbType.BigInt;
                    if (!isNull) value = long.Parse(RequireString(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
                    break;
                case "decimal":
                    parameter.SqlDbType = SqlDbType.Decimal;
                    if (!Precision.HasValue || !Scale.HasValue || Precision < 1 || Precision > 38 || Scale > Precision)
                        throw new ArgumentException("decimal requires precision 1..38 and scale 0..precision.");
                    parameter.Precision = Precision.Value;
                    parameter.Scale = Scale.Value;
                    if (!isNull)
                    {
                        var parsed = SqlDecimal.Parse(RequireString());
                        var adjusted = SqlDecimal.ConvertToPrecScale(parsed, Precision.Value, Scale.Value);
                        if (SqlDecimal.NotEquals(parsed, adjusted).Value) throw new ArgumentException("Decimal parameter would be rounded.");
                        value = adjusted;
                    }
                    break;
                case "nvarchar":
                    parameter.SqlDbType = SqlDbType.NVarChar;
                    if (!Size.HasValue || (Size != -1 && (Size < 1 || Size > 4000)))
                        throw new ArgumentException("nvarchar requires size 1..4000 or -1 (max).");
                    parameter.Size = Size.Value;
                    if (!isNull)
                    {
                        var text = RequireString();
                        if (text.Length > 65536 || (Size != -1 && text.Length > Size)) throw new ArgumentException("nvarchar value exceeds its declared size or 65536 characters.");
                        value = text;
                    }
                    break;
                case "uniqueidentifier":
                    parameter.SqlDbType = SqlDbType.UniqueIdentifier;
                    if (!isNull) value = Guid.ParseExact(RequireString(), "D");
                    break;
                case "date":
                    parameter.SqlDbType = SqlDbType.Date;
                    if (!isNull) value = DateTime.ParseExact(RequireString(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None);
                    break;
                case "datetime2":
                    parameter.SqlDbType = SqlDbType.DateTime2;
                    parameter.Scale = 7;
                    if (!isNull) value = DateTime.ParseExact(RequireString(), new[] { "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF" }, CultureInfo.InvariantCulture, DateTimeStyles.None);
                    break;
                default: throw new ArgumentException("Unsupported parameter type: " + Type + ".");
            }
            parameter.Value = value;
            return parameter;
        }

        private string RequireString()
        {
            if (Value.ValueKind != JsonValueKind.String) throw new ArgumentException(Type + " parameters must use JSON strings.");
            return Value.GetString()!;
        }

        private static bool AsciiLetter(char value) => value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z';
    }
}
