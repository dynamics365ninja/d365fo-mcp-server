using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace D365MetadataBridge.Protocol
{
    /// <summary>
    /// JSON-RPC style request from the Node.js MCP server
    /// </summary>
    public class BridgeRequest
    {
        [JsonPropertyName("id")]
        public string Id { get; set; } = "";

        [JsonPropertyName("method")]
        public string Method { get; set; } = "";

        [JsonPropertyName("params")]
        public JsonElement? Params { get; set; }

        /// <summary>
        /// Helper to extract a string parameter from Params
        /// </summary>
        public string? GetStringParam(string name)
        {
            if (Params == null || Params.Value.ValueKind != JsonValueKind.Object)
                return null;

            if (Params.Value.TryGetProperty(name, out var prop) && prop.ValueKind == JsonValueKind.String)
                return prop.GetString();

            return null;
        }

        /// <summary>
        /// Helper to extract an integer parameter from Params
        /// </summary>
        public int? GetIntParam(string name)
        {
            if (Params == null || Params.Value.ValueKind != JsonValueKind.Object)
                return null;

            if (Params.Value.TryGetProperty(name, out var prop) && prop.ValueKind == JsonValueKind.Number)
                return prop.GetInt32();

            return null;
        }

        /// <summary>
        /// Helper to extract a boolean parameter from Params
        /// </summary>
        public bool? GetBoolParam(string name)
        {
            if (Params == null || Params.Value.ValueKind != JsonValueKind.Object)
                return null;

            if (Params.Value.TryGetProperty(name, out var prop) &&
                (prop.ValueKind == JsonValueKind.True || prop.ValueKind == JsonValueKind.False))
                return prop.GetBoolean();

            return null;
        }

        /// <summary>
        /// Helper to deserialize a complex parameter (array or object) from Params.
        /// Returns default(T) if parameter is missing or null.
        /// </summary>
        public T? GetParam<T>(string name) where T : class
        {
            if (Params == null || Params.Value.ValueKind != JsonValueKind.Object)
                return null;

            if (!Params.Value.TryGetProperty(name, out var prop))
                return null;

            if (prop.ValueKind == JsonValueKind.Null)
                return null;

            return JsonSerializer.Deserialize<T>(prop.GetRawText(), JsonOptions.Default);
        }

        /// <summary>
        /// Helper to extract a Dictionary&lt;string,string&gt; from a JSON object parameter.
        /// </summary>
        public Dictionary<string, string>? GetDictParam(string name)
        {
            if (Params == null || Params.Value.ValueKind != JsonValueKind.Object)
                return null;

            if (!Params.Value.TryGetProperty(name, out var prop) || prop.ValueKind != JsonValueKind.Object)
                return null;

            var dict = new Dictionary<string, string>();
            foreach (var kv in prop.EnumerateObject())
            {
                dict[kv.Name] = kv.Value.GetString() ?? kv.Value.GetRawText();
            }
            return dict;
        }
    }

    /// <summary>
    /// JSON-RPC style response sent to the Node.js MCP server
    /// </summary>
    public class BridgeResponse
    {
        [JsonPropertyName("id")]
        public string Id { get; set; } = "";

        [JsonPropertyName("result")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public JsonElement? Result { get; set; }

        [JsonPropertyName("error")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public BridgeError? Error { get; set; }

        public static BridgeResponse CreateSuccess(string id, object result)
        {
            return new BridgeResponse
            {
                Id = id,
                Result = JsonSerializer.SerializeToElement(result, JsonOptions.Default)
            };
        }

        public static BridgeResponse CreateError(string id, int code, string message)
        {
            return new BridgeResponse
            {
                Id = id,
                Error = new BridgeError { Code = code, Message = message }
            };
        }
    }

    /// <summary>
    /// Error object in the response
    /// </summary>
    public class BridgeError
    {
        [JsonPropertyName("code")]
        public int Code { get; set; }

        [JsonPropertyName("message")]
        public string Message { get; set; } = "";
    }

    /// <summary>
    /// Shared JSON serializer options
    /// </summary>
    public static class JsonOptions
    {
        public static readonly JsonSerializerOptions Default = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = false
        };
    }
}
