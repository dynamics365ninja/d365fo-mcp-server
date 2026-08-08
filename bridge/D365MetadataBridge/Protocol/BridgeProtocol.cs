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
        /// Helper to extract a boolean parameter from Params.
        /// Reads through ParamCoercion so this path and HandleBatchModify cannot disagree
        /// about what a given value means.
        /// </summary>
        public bool? GetBoolParam(string name)
        {
            if (Params == null || Params.Value.ValueKind != JsonValueKind.Object)
                return null;

            if (!Params.Value.TryGetProperty(name, out var prop))
                return null;

            return ParamCoercion.ToBool(prop, name);
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
                // GetString() THROWS on any kind other than String/Null — it does not
                // return null for booleans/numbers/arrays. The old `GetString() ?? …`
                // therefore crashed the whole request with "requires an element of type
                // 'String', but the target element has type 'True'/'Array'" whenever a
                // caller put a non-string value in the map. Coerce by kind instead.
                switch (kv.Value.ValueKind)
                {
                    case JsonValueKind.String:
                        dict[kv.Name] = kv.Value.GetString() ?? string.Empty;
                        break;
                    case JsonValueKind.Null:
                        break; // omit null-valued properties
                    default:
                        // bool/number/array/object → raw JSON token ("true", "42", "[…]")
                        dict[kv.Name] = kv.Value.GetRawText();
                        break;
                }
            }
            return dict;
        }
    }

    /// <summary>
    /// Parameter coercion shared by BOTH dispatch paths.
    ///
    /// The single-op path reads its params straight off the request's JsonElement; the
    /// batch path gets them as Dictionary&lt;string, object&gt;, whose values System.Text.Json
    /// boxes as JsonElement. JsonElement does not implement IConvertible, so the batch
    /// path's Convert.ToBoolean(value) threw InvalidCastException ("Object must implement
    /// IConvertible") for EVERY operation carrying a bool — mandatory, allowDuplicates,
    /// alternateKey, extendBaseFieldGroup — and HandleBatchModify's per-op catch reported
    /// that cast as the operation's reason for failing. Booleans are read by JSON kind, in
    /// one place, so the two paths cannot drift apart again.
    /// </summary>
    public static class ParamCoercion
    {
        /// <summary>
        /// Boolean from a raw (boxed) batch parameter value.
        /// </summary>
        public static bool? ToBool(object? value, string paramName)
        {
            switch (value)
            {
                case null: return null;
                case bool b: return b;
                case JsonElement el: return ToBool(el, paramName);
                case string s: return ParseBoolText(s, paramName, s);
                default:
                    throw new ArgumentException(
                        $"Parameter '{paramName}' must be a boolean — got {value.GetType().Name} '{value}'.");
            }
        }

        /// <summary>
        /// Boolean from a JSON value. Absent/null yields null so the caller's own default
        /// applies; a value that is present but not readable as a boolean throws rather
        /// than degrading to false — a silent false writes a field that is not mandatory,
        /// or an index that allows duplicates, and reports success either way.
        ///
        /// The string spellings are accepted because the AxTable XML value is No/Yes and
        /// callers reach for that form (#27); it is a typo, not a shape, that fails here.
        /// </summary>
        public static bool? ToBool(JsonElement el, string paramName)
        {
            switch (el.ValueKind)
            {
                case JsonValueKind.True: return true;
                case JsonValueKind.False: return false;
                case JsonValueKind.Null:
                case JsonValueKind.Undefined: return null;
                case JsonValueKind.String: return ParseBoolText(el.GetString(), paramName, el.GetRawText());
                case JsonValueKind.Number when el.TryGetInt32(out var n) && (n == 0 || n == 1):
                    return n == 1;
                default:
                    throw new ArgumentException(
                        $"Parameter '{paramName}' must be a boolean — got {el.ValueKind} {el.GetRawText()}. " +
                        "Accepted: true/false, \"true\"/\"false\", \"Yes\"/\"No\", 1/0.");
            }
        }

        private static bool? ParseBoolText(string? text, string paramName, string received)
        {
            switch (text?.Trim().ToLowerInvariant())
            {
                case null:
                case "": return null;
                case "true": case "yes": case "1": return true;
                case "false": case "no": case "0": return false;
                default:
                    throw new ArgumentException(
                        $"Parameter '{paramName}' must be a boolean — got {received}. " +
                        "Accepted: true/false, \"true\"/\"false\", \"Yes\"/\"No\", 1/0.");
            }
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
