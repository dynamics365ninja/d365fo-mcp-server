using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Resources;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace BinaryModelExtractor
{
    /// <summary>
    /// Exports the non-class object kinds (forms, queries, views, data entities, maps, menu items,
    /// security, extensions, ...) as AOT object XML through Microsoft's own MetadataSerializer, into
    /// a synthetic &lt;dump&gt;\aot\&lt;Module&gt;\&lt;Module&gt;\Ax&lt;Kind&gt;\&lt;Name&gt;.xml tree that the stock
    /// extract-metadata parsers index unchanged. A compiled model has no method bodies: the
    /// serialized XML carries method names only, and any &lt;Source&gt; text is blanked as a guard.
    /// </summary>
    static class AotExport
    {
        // Provider property names; the folder name comes from the serialized root element (AxForm, AxQuery, ...).
        public static readonly string[] Kinds =
        {
            "Forms", "Queries", "Views", "DataEntityViews", "Maps",
            "MenuItemDisplays", "MenuItemActions", "MenuItemOutputs",
            "SecurityRoles", "SecurityDuties", "SecurityPrivileges", "SecurityPolicies",
            "Services", "ServiceGroups", "ConfigurationKeys", "LicenseCodes",
            "TableExtensions", "FormExtensions", "EnumExtensions", "EdtExtensions", "ViewExtensions",
            "DataEntityViewExtensions", "MapExtensions", "QuerySimpleExtensions", "MenuExtensions",
            "MenuItemDisplayExtensions", "MenuItemActionExtensions", "MenuItemOutputExtensions",
            "SecurityRoleExtensions", "SecurityDutyExtensions",
        };

        static readonly Regex RootName = new Regex(@"<(Ax[A-Za-z]+)[\s>]", RegexOptions.Compiled);
        static readonly Regex SourceText = new Regex(@"<Source>\s*<!\[CDATA\[(?=[\s\S]*?\S)[\s\S]*?\]\]>\s*</Source>", RegexOptions.Compiled);

        static MethodInfo One(object o, string name) =>
            o.GetType().GetMethods().First(m => m.Name == name && m.GetParameters().Length == 1 && m.GetParameters()[0].ParameterType == typeof(string));

        /// <summary>Exports one provider collection. `moduleOf` maps a model display name to its module folder (null = skip).</summary>
        public static void ExportKind(object prov, string kind, object serializer, string aotRoot,
            Func<object?, string?> modelOf, Func<string, string?> moduleOf, Func<string, bool> wanted,
            Dictionary<string, Dictionary<string, int>> counts, Dictionary<string, List<string>> errors)
        {
            var coll = prov.GetType().GetProperty(kind)?.GetValue(prov);
            if (coll == null) return;
            var keys = ((IEnumerable)coll.GetType().GetMethod("GetPrimaryKeys", Type.EmptyTypes).Invoke(coll, null)).Cast<string>().ToList();
            var getModel = One(coll, "GetModelInfo");
            var read = One(coll, "Read");
            var ser = serializer.GetType().GetMethods().First(m => m.Name == "Serialize" && m.GetParameters().Length == 1);
            foreach (var k in keys)
            {
                string? model;
                try { model = modelOf(((IEnumerable)getModel.Invoke(coll, new object[] { k })).Cast<object>().FirstOrDefault()); }
                catch { continue; }
                if (model == null || !wanted(model)) continue;
                var module = moduleOf(model);
                if (module == null) continue;
                try
                {
                    var obj = read.Invoke(coll, new object[] { k });
                    if (obj == null) continue;
                    var xml = (string)ser.Invoke(serializer, new[] { obj });
                    var m = RootName.Match(xml);
                    if (!m.Success) continue;
                    if (SourceText.IsMatch(xml)) xml = SourceText.Replace(xml, "<Source><![CDATA[]]></Source>");
                    var folder = m.Groups[1].Value;
                    if (folder == "AxQuerySimple") // in memory a query is AxQuerySimple; the AOT file root (and folder) is AxQuery
                    {
                        folder = "AxQuery";
                        xml = xml.Replace("<AxQuerySimple ", "<AxQuery ").Replace("</AxQuerySimple>", "</AxQuery>");
                    }
                    var dir = Path.Combine(aotRoot, module, module, folder);
                    Directory.CreateDirectory(dir);
                    File.WriteAllText(Path.Combine(dir, SafeFile(k) + ".xml"), xml, new UTF8Encoding(false));
                    if (!counts.TryGetValue(model, out var c)) counts[model] = c = new Dictionary<string, int>();
                    c[folder] = (c.TryGetValue(folder, out var n) ? n : 0) + 1;
                }
                catch (Exception ex)
                {
                    var inner = ex is TargetInvocationException tie && tie.InnerException != null ? tie.InnerException : ex;
                    if (!errors.TryGetValue(model, out var l)) errors[model] = l = new List<string>();
                    l.Add(kind + " " + k + ": " + inner.GetType().Name + ": " + inner.Message);
                }
            }
        }

        static string SafeFile(string n) => string.Join("_", n.Split(Path.GetInvalidFileNameChars()));

        /// <summary>Finds the package folder that holds a module's compiled output (bin\Dynamics.AX.&lt;Module&gt;.*).</summary>
        public static string? FindPackageDir(string pld, string module)
        {
            var direct = Path.Combine(pld, module);
            if (Directory.Exists(direct)) return direct;
            foreach (var d in Directory.EnumerateDirectories(pld))
            {
                var bin = Path.Combine(d, "bin");
                if (File.Exists(Path.Combine(bin, module + "_ModelInfo.md")) || File.Exists(Path.Combine(bin, "Dynamics.AX." + module + ".0.netmodule"))) return d;
            }
            return null;
        }

        /// <summary>
        /// Label texts from the satellite resource assemblies (Resources\&lt;lang&gt;\&lt;LabelFileId&gt;.resources.dll)
        /// into the .label.txt layout `build-database` already indexes. Returns label count per language.
        /// </summary>
        public static Dictionary<string, int> ExportLabels(string packageDir, string module, string aotRoot, HashSet<string>? languages)
        {
            var result = new Dictionary<string, int>();
            var res = Path.Combine(packageDir, "Resources");
            if (!Directory.Exists(res)) return result;
            foreach (var langDir in Directory.EnumerateDirectories(res))
            {
                var lang = Path.GetFileName(langDir);
                if (languages != null && !languages.Contains(lang)) continue;
                foreach (var dll in Directory.EnumerateFiles(langDir, "*.resources.dll"))
                {
                    var fn = Path.GetFileName(dll);
                    var labelFileId = fn.Substring(0, fn.Length - ".resources.dll".Length);
                    try
                    {
                        // Data-only read of the embedded .resources stream (ReflectionOnlyLoad: nothing is executed).
                        var asm = Assembly.ReflectionOnlyLoad(File.ReadAllBytes(dll));
                        var sb = new StringBuilder();
                        int n = 0;
                        foreach (var rn in asm.GetManifestResourceNames().Where(x => x.EndsWith(".resources")))
                            using (var s = asm.GetManifestResourceStream(rn))
                            using (var r = new ResourceReader(s))
                                foreach (DictionaryEntry e in r)
                                {
                                    var key = (string)e.Key;
                                    if (!(e.Value is string text) || key.Length == 0 || key.Any(char.IsWhiteSpace)) continue;
                                    sb.Append(key).Append('=').Append(Regex.Replace(text, @"\r\n|\r|\n", " ")).Append('\n');
                                    n++;
                                }
                        if (n == 0) continue;
                        var dir = Path.Combine(aotRoot, module, module, "AxLabelFile", "LabelResources", lang);
                        Directory.CreateDirectory(dir);
                        File.WriteAllText(Path.Combine(dir, labelFileId + "." + lang + ".label.txt"), sb.ToString(), new UTF8Encoding(false));
                        result[lang] = (result.TryGetValue(lang, out var c) ? c : 0) + n;
                    }
                    catch { /* unreadable satellite: labels stay as references */ }
                }
            }
            return result;
        }

        /// <summary>Chain-of-command wraps the compiler recorded for a module (bin\Dynamics.AX.&lt;Module&gt;.ChainOfCommand.xml).</summary>
        public static List<CocClass> ReadChainOfCommand(string packageDir, string module)
        {
            var list = new List<CocClass>();
            var f = Path.Combine(packageDir, "bin", "Dynamics.AX." + module + ".ChainOfCommand.xml");
            if (!File.Exists(f)) return list;
            foreach (var ec in XDocument.Load(f).Descendants("ExtensionClass"))
            {
                var c = new CocClass { Class = (string)ec.Attribute("Name"), Target = (string)ec.Attribute("ExtensionTarget"), TargetType = (string)ec.Attribute("ExtensionTargetType") };
                foreach (var m in ec.Elements("Method"))
                    c.Methods.Add(new CocMethod
                    {
                        Name = m.Value.Trim(),
                        IsStatic = string.Equals((string)m.Attribute("IsStatic"), "True", StringComparison.OrdinalIgnoreCase),
                        Owner = (string)m.Attribute("CocMethodDelegateElementOwner"),
                        NestedKind = (string)m.Attribute("CoCNestedElementKind"),
                        RootForm = Nz((string)m.Attribute("CoCRootFormName")),
                    });
                list.Add(c);
            }
            return list;
        }

        static string? Nz(string? s) => string.IsNullOrEmpty(s) ? null : s;
    }

    class CocMethod { public string? Name { get; set; } public bool IsStatic { get; set; } public string? Owner { get; set; } public string? NestedKind { get; set; } public string? RootForm { get; set; } }
    class CocClass { public string? Class { get; set; } public string? Target { get; set; } public string? TargetType { get; set; } public List<CocMethod> Methods { get; set; } = new List<CocMethod>(); }
}
