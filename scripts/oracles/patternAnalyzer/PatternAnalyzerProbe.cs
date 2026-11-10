// PatternAnalyzerProbe: asks the platform's own form pattern engine
// (Microsoft.Dynamics.AX.Metadata.Patterns.PatternAnalyzer, the code the X++
// compiler runs) for its verdict. Built and driven by scripts/oracles/patternAnalyzer.ts.
//
//   PatternAnalyzerProbe.exe analyze <bin> <storeRoot> [formName ...]
//     One JSON line per patterned node (Design and every container that declares
//     a sub-pattern): {form, path, pattern, version, resolved, ok, detail}.
//     Without form names every form in the store is analysed.
//
//   PatternAnalyzerProbe.exe defaults <bin> <Prop,Prop,...>
//     One JSON object: control type -> property -> default value, read from a new
//     instance of every AxForm*Control metamodel class (and AxFormDesign as
//     "FormDesign"). This is the value a property has when the AxForm XML omits it,
//     which is what the engine compares when a form does not set a property.
//
// Read only: it never writes into the store or PackagesLocalDirectory.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using Microsoft.Dynamics.AX.Metadata.MetaModel;
using Microsoft.Dynamics.AX.Metadata.Patterns;
using Microsoft.Dynamics.AX.Metadata.Storage;

internal static class PatternAnalyzerProbe
{
    private static string bin;

    private static int Main(string[] args)
    {
        if (args.Length < 3)
        {
            Console.Error.WriteLine("usage: analyze <bin> <storeRoot> [form ...] | defaults <bin> <Prop,Prop,...>");
            return 2;
        }
        bin = args[1];
        AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
        {
            var p = Path.Combine(bin, new AssemblyName(e.Name).Name + ".dll");
            return File.Exists(p) ? Assembly.LoadFrom(p) : null;
        };
        var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        try
        {
            if (args[0] == "analyze") Analyze(output, args[2], args.Skip(3).ToArray());
            else if (args[0] == "defaults") Defaults(output, args[2].Split(','));
            else { Console.Error.WriteLine("unknown mode " + args[0]); return 2; }
        }
        finally { output.Flush(); }
        return 0;
    }

    private static string J(string s)
    {
        if (s == null) return "null";
        var b = new StringBuilder("\"");
        foreach (var c in s)
        {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c < ' ') b.AppendFormat("\\u{0:x4}", (int)c);
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }

    // analyze

    private static PatternFactory factory;

    private static void Analyze(StreamWriter o, string root, string[] names)
    {
        var provider = new MetadataProviderFactory().CreateDiskProvider(root);
        factory = new PatternFactory(true);
        IEnumerable<string> forms = names.Length > 0 ? names : provider.Forms.GetPrimaryKeys();
        foreach (var name in forms)
        {
            AxForm form;
            try { form = provider.Forms.Read(name); }
            catch (Exception ex) { o.WriteLine("{\"form\":" + J(name) + ",\"readError\":" + J(ex.Message) + "}"); continue; }
            if (form == null || form.Design == null) continue;
            Test(o, name, "Design", form.Design);
            Walk(o, name, "Design", form.Design.Controls);
        }
    }

    private static void Walk(StreamWriter o, string form, string path, IEnumerable<AxFormControl> controls)
    {
        if (controls == null) return;
        foreach (var c in controls)
        {
            var p = path + "/" + c.Name;
            var patternable = c as IPatternable;
            if (patternable != null && !string.IsNullOrEmpty(patternable.Pattern)) Test(o, form, p, patternable);
            var container = c as IFormControlCollection;
            if (container != null) Walk(o, form, p, container.Controls);
        }
    }

    private static void Test(StreamWriter o, string form, string path, IPatternable target)
    {
        if (string.IsNullOrEmpty(target.Pattern)) return;
        var pattern = factory.GetPatternByName(target.Pattern, target.PatternVersion, false);
        var head = "{\"form\":" + J(form) + ",\"path\":" + J(path) + ",\"pattern\":" + J(target.Pattern) + ",\"version\":" + J(target.PatternVersion);
        if (pattern == null)
        {
            o.WriteLine(head + ",\"resolved\":null,\"ok\":null,\"detail\":\"no platform definition\"}");
            return;
        }
        PatternResult r;
        try { r = new PatternAnalyzer().TestPattern(target, pattern, null); }
        catch (Exception ex) { o.WriteLine(head + ",\"error\":" + J(ex.GetType().Name + ": " + ex.Message) + "}"); return; }
        var detail = new StringBuilder();
        Collect(r, "", detail);
        var ok = r.AllDescendantNodesMatched && !r.ExtraDescendants && !r.AnyViolations && !r.ChildrenAnyViolations;
        o.WriteLine(head + ",\"resolved\":" + J(pattern.Version) + ",\"ok\":" + (ok ? "true" : "false")
            + ",\"matched\":" + (r.AllDescendantNodesMatched ? "true" : "false")
            + ",\"extra\":" + (r.ExtraDescendants ? "true" : "false")
            + ",\"violations\":" + (r.AnyViolations || r.ChildrenAnyViolations ? "true" : "false")
            + ",\"detail\":" + J(detail.ToString().TrimEnd()) + "}");
    }

    private static void Collect(PatternResult r, string path, StringBuilder sb)
    {
        var here = path + "/" + (r.Control == null ? "?" : r.Control.Name);
        if (r.Violations != null)
            foreach (var v in r.Violations)
                sb.Append(here + ": " + v.PropertyName + " " + v.Op + " '" + v.PatternValue + "' actual '" + v.ActualValue + "'; ");
        if (r.ExtraChildren) sb.Append(here + ": extra children; ");
        if (r.ChildResults == null) return;
        foreach (var kv in r.ChildResults)
        {
            if (kv.Value == null || kv.Value.Count == 0)
            {
                if (kv.Key.RequireOne) sb.Append(here + ": missing " + (kv.Key.Part ?? kv.Key.Type) + "; ");
                continue;
            }
            foreach (var child in kv.Value) Collect(child, here, sb);
        }
    }

    // defaults

    private static void Defaults(StreamWriter o, string[] props)
    {
        var metadata = Assembly.LoadFrom(Path.Combine(bin, "Microsoft.Dynamics.AX.Metadata.dll"));
        Type[] types;
        try { types = metadata.GetTypes(); }
        catch (ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray(); }
        var classes = new SortedDictionary<string, Type>(StringComparer.Ordinal);
        foreach (var t in types)
        {
            if (!t.IsClass || t.IsAbstract || t.Namespace != "Microsoft.Dynamics.AX.Metadata.MetaModel") continue;
            if (t.Name == "AxFormDesign") classes["FormDesign"] = t;
            else if (t.Name == "AxFormControl") classes["Control"] = t;
            else if (t.Name.StartsWith("AxForm") && t.Name.EndsWith("Control") && typeof(AxFormControl).IsAssignableFrom(t))
                classes[t.Name.Substring(6, t.Name.Length - 13)] = t;
        }
        o.Write("{");
        var firstType = true;
        foreach (var kv in classes)
        {
            object instance;
            try { instance = Activator.CreateInstance(kv.Value); }
            catch { continue; }
            var values = new List<string>();
            foreach (var prop in props)
            {
                var pi = kv.Value.GetProperty(prop, BindingFlags.Public | BindingFlags.Instance);
                if (pi == null || pi.GetIndexParameters().Length > 0) continue;
                object v;
                try { v = pi.GetValue(instance, null); }
                catch { continue; }
                values.Add(J(prop) + ":" + J(v == null ? "" : v.ToString()));
            }
            o.Write((firstType ? "" : ",") + "\n" + J(kv.Key) + ":{" + string.Join(",", values) + "}");
            firstType = false;
        }
        o.WriteLine("\n}");
    }
}
