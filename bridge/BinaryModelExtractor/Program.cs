using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;

namespace BinaryModelExtractor
{
    /// <summary>
    /// Binary ISV model extractor
    ///
    /// Reads compiled-only D365FO models through Microsoft's runtime metadata provider
    /// (MetadataProviderFactory.CreateRuntimeProvider) and writes a signatures-only JSON dump per
    /// model, plus the non-class objects as serialized AOT XML (see AotExport).
    ///
    ///   BinaryModelExtractor.exe --packages-path &lt;PackagesLocalDirectory&gt; --out &lt;dir&gt;
    ///       [--models A,B] [--languages en-US,cs|all] [--no-aot] [--bin-path &lt;bin&gt;]
    ///
    /// The provider needs &lt;PLD&gt;\bin (platform assemblies), &lt;PLD&gt;\StaticMetadata and the
    /// packages' own bin\ folders. Nothing that looks like a method body is written:
    /// AxMethod.Source is never read, and the TS importer reduces the class Declaration to the
    /// header and member variables.
    /// </summary>
    static class Program
    {
        static string _bin = "";

        static int Main(string[] args)
        {
            string? pld = null, outDir = null, binPath = null, models = null;
            var languages = "en-US";
            bool noAot = false;
            for (int i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--packages-path": pld = args[++i]; break;
                    case "--out": outDir = args[++i]; break;
                    case "--bin-path": binPath = args[++i]; break;
                    case "--models": models = args[++i]; break;
                    case "--languages": languages = args[++i]; break;
                    case "--no-aot": noAot = true; break;
                }
            }
            if (pld == null || outDir == null)
            {
                Console.Error.WriteLine("usage: BinaryModelExtractor --packages-path <PLD> --out <dir> [--models A,B] [--bin-path <bin>]");
                return 2;
            }
            _bin = binPath ?? Path.Combine(pld, "bin");
            AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
            {
                var p = Path.Combine(_bin, new AssemblyName(e.Name).Name + ".dll");
                return File.Exists(p) ? Assembly.LoadFrom(p) : null;
            };
            return Extract(pld, outDir, models == null ? null : new HashSet<string>(models.Split(','), StringComparer.OrdinalIgnoreCase),
                languages == "all" ? null : new HashSet<string>(languages.Split(','), StringComparer.OrdinalIgnoreCase), noAot);
        }

        // Separate method: JIT must not touch D365FO types before AssemblyResolve is registered.
        [MethodImpl(MethodImplOptions.NoInlining)]
        static int Extract(string pld, string outDir, HashSet<string>? modelFilter, HashSet<string>? languages, bool noAot)
        {
            var factory = new Microsoft.Dynamics.AX.Metadata.Storage.MetadataProviderFactory();
            var prov = factory.CreateRuntimeProvider(new Microsoft.Dynamics.AX.Metadata.Storage.Runtime.RuntimeProviderConfiguration(pld));
            if (prov == null) { Console.Error.WriteLine("CreateRuntimeProvider returned null"); return 3; }
            Directory.CreateDirectory(outDir);

            var byModel = new Dictionary<string, ModelDump>(StringComparer.OrdinalIgnoreCase);
            // --models matches a model's display name or its module name.
            bool wanted(string m) => modelFilter == null || modelFilter.Contains(m)
                || (ModelProps.TryGetValue(m, out var props) && props.TryGetValue("Module", out var mod) && modelFilter.Contains(mod));
            ModelDump Get(string m) { if (!byModel.TryGetValue(m, out var d)) byModel[m] = d = new ModelDump { Model = m }; return d; }

            int skipped = 0;
            void Each<T>(string kind, Func<IEnumerable<string>> keys, Func<string, string?> modelOf, Func<string, T> read, Action<ModelDump, T> add)
            {
                foreach (var k in keys().ToList())
                {
                    string model;
                    try { model = modelOf(k) ?? "Unknown"; } catch { model = "Unknown"; }
                    if (!wanted(model)) { skipped++; continue; }
                    try { var o = read(k); if (o != null) add(Get(model), o); }
                    catch (Exception ex) { Get(model).Errors.Add(kind + " " + k + ": " + ex.GetType().Name + ": " + ex.Message); }
                }
            }

            Each("class", () => prov.Classes.GetPrimaryKeys(), k => FirstModel(prov.Classes.GetModelInfo(k)), prov.Classes.Read, (d, o) => d.Classes.Add(MapClass(o)));
            Each("table", () => prov.Tables.GetPrimaryKeys(), k => FirstModel(prov.Tables.GetModelInfo(k)), prov.Tables.Read, (d, o) => d.Tables.Add(MapTable(o)));
            Each("edt", () => prov.Edts.GetPrimaryKeys(), k => FirstModel(prov.Edts.GetModelInfo(k)), prov.Edts.Read, (d, o) => d.Edts.Add(MapEdt(o)));
            Each("enum", () => prov.Enums.GetPrimaryKeys(), k => FirstModel(prov.Enums.GetModelInfo(k)), prov.Enums.Read, (d, o) => d.Enums.Add(MapEnum(o)));

            // Everything that is not a class/table/EDT/enum: serialized AOT XML (stock parsers read it), labels, CoC wraps.
            var aotRoot = Path.Combine(outDir, "aot");
            var exported = new Dictionary<string, Dictionary<string, int>>(StringComparer.OrdinalIgnoreCase);
            var exportErrors = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
            object serializer = Activator.CreateInstance(typeof(Microsoft.Dynamics.AX.Metadata.Providers.IMetadataProvider).Assembly.GetType("Microsoft.Dynamics.AX.Metadata.Core.IO.MetadataSerializer", false)
                ?? System.Reflection.Assembly.Load("Microsoft.Dynamics.AX.Metadata.Core").GetType("Microsoft.Dynamics.AX.Metadata.Core.IO.MetadataSerializer", true));
            Func<string, string?> moduleOf = m => ModelProps.TryGetValue(m, out var b) && b.TryGetValue("Module", out var mod) && !string.IsNullOrEmpty(mod) ? mod : null;
            foreach (var kind in noAot ? new string[0] : AotExport.Kinds)
                AotExport.ExportKind(prov, kind, serializer, aotRoot, mi => mi == null ? null : FirstModel(new[] { mi }), moduleOf, wanted, exported, exportErrors);
            foreach (var kv in exportErrors) Get(kv.Key).Errors.AddRange(kv.Value);

            // Platform baseline: which application modules this provider can see (for the compatibility check).
            var known = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var mi in prov.ModelManifest.ListModelInfos())
                known[mi.Module ?? mi.Name] = $"{mi.VersionMajor}.{mi.VersionMinor}.{mi.VersionBuild}.{mi.VersionRevision}";
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var k in prov.Classes.GetPrimaryKeys()) names.Add(k);
            foreach (var k in prov.Tables.GetPrimaryKeys()) names.Add(k);
            foreach (var k in prov.Edts.GetPrimaryKeys()) names.Add(k);
            foreach (var k in prov.Enums.GetPrimaryKeys()) names.Add(k);
            foreach (var k in prov.Views.GetPrimaryKeys()) names.Add(k);
            foreach (var k in prov.DataEntityViews.GetPrimaryKeys()) names.Add(k);
            foreach (var k in prov.Maps.GetPrimaryKeys()) names.Add(k);

            var provVersion = FileVersion("Microsoft.Dynamics.AX.Metadata.dll");
            var opts = new JsonSerializerOptions { WriteIndented = true, DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull };
            foreach (var d in byModel.Values)
            {
                d.Provider = "RuntimeMetadataProvider";
                if (d.Model != null && ModelProps.TryGetValue(d.Model, out var props)) d.ModelInfo = props;
                d.ProviderFileVersion = provVersion;
                if (exported.TryGetValue(d.Model!, out var ex)) d.Exported = ex;
                var module = d.ModelInfo != null && d.ModelInfo.TryGetValue("Module", out var mm) ? mm : null;
                var pkgDir = module == null ? null : AotExport.FindPackageDir(pld, module);
                if (pkgDir != null)
                {
                    d.ChainOfCommand = AotExport.ReadChainOfCommand(pkgDir, module!);
                    if (!noAot) d.Labels = AotExport.ExportLabels(pkgDir, module!, aotRoot, languages);
                }
                d.Platform = new PlatformDump
                {
                    ProviderFileVersion = provVersion,
                    PackagesPath = pld,
                    Modules = new[] { "ApplicationPlatform", "ApplicationFoundation", "ApplicationSuite", "ApplicationCommon" }
                        .Where(known.ContainsKey).ToDictionary(x => x, x => known[x]),
                    MissingModules = RefsOf(d.Model).Where(r => !known.ContainsKey(r)).ToList(),
                };
                d.Unresolved = Unresolved(d, names);
                d.Classes.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
                d.Tables.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
                d.Edts.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
                d.Enums.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
                File.WriteAllText(Path.Combine(outDir, d.Model + ".binary.json"), JsonSerializer.Serialize(d, opts));
                Console.WriteLine($"{d.Model}: aot={(d.Exported == null ? 0 : d.Exported.Values.Sum())} labels={(d.Labels == null ? 0 : d.Labels.Values.Sum())} coc={(d.ChainOfCommand == null ? 0 : d.ChainOfCommand.Count)} unresolved={d.Unresolved.Count}/{d.Unresolved.Checked} classes={d.Classes.Count} methods={d.Classes.Sum(c => c.Methods.Count)} tables={d.Tables.Count} edts={d.Edts.Count} enums={d.Enums.Count} errors={d.Errors.Count}");
            }
            if (skipped > 0) Console.WriteLine($"(skipped {skipped} objects outside --models)");
            return 0;
        }

        static readonly Dictionary<string, Dictionary<string, string>> ModelProps = new Dictionary<string, Dictionary<string, string>>(StringComparer.OrdinalIgnoreCase);

        static readonly Dictionary<string, List<string>> ModuleRefs = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        static List<string> RefsOf(string model) => ModuleRefs.TryGetValue(model, out var l) ? l : new List<string>();

        /// <summary>References from the ISV's own objects to objects the provider does not know (base classes, EDTs, enums, related tables).</summary>
        static UnresolvedDump Unresolved(ModelDump d, HashSet<string> names)
        {
            var u = new UnresolvedDump();
            void Chk(string from, string? to)
            {
                if (string.IsNullOrEmpty(to) || to.Contains('.')) return; // CLR types (System.*) are not in the metadata
                u.Checked++;
                if (!names.Contains(to!)) { u.Count++; if (u.Examples.Count < 15) u.Examples.Add(from + " -> " + to); }
            }
            foreach (var c in d.Classes) { Chk("class " + c.Name, c.Extends); foreach (var i in c.Implements ?? new List<string>()) Chk("class " + c.Name, i); }
            foreach (var t in d.Tables)
            {
                Chk("table " + t.Name, t.Extends);
                foreach (var f in t.Fields) { Chk("table " + t.Name + "." + f.Name, f.Edt); Chk("table " + t.Name + "." + f.Name, f.EnumType); }
                foreach (var r in t.Relations) Chk("table " + t.Name + " relation " + r.Name, r.RelatedTable);
            }
            foreach (var e in d.Edts) Chk("edt " + e.Name, e.Extends);
            return u;
        }

        static string? FirstModel(System.Collections.IEnumerable mis)
        {
            foreach (object mi in mis)
            {
                var name = (string)mi.GetType().GetProperty("Name").GetValue(mi);
                if (name != null && !ModelProps.ContainsKey(name))
                {
                    var bag = new Dictionary<string, string>();
                    foreach (var pr in mi.GetType().GetProperties())
                    {
                        if (pr.GetIndexParameters().Length > 0) continue;
                        try { var v = pr.GetValue(mi); if (v != null && (v is string || v.GetType().IsPrimitive || v.GetType().IsEnum)) bag[pr.Name] = v.ToString(); } catch { }
                    }
                    ModelProps[name] = bag;
                    try { if (mi.GetType().GetProperty("ModuleReferences")?.GetValue(mi) is IEnumerable<string> refs) ModuleRefs[name] = refs.ToList(); } catch { }
                }
                return name;
            }
            return null;
        }

        static string? FileVersion(string dll)
        {
            try { return System.Diagnostics.FileVersionInfo.GetVersionInfo(Path.Combine(_bin, dll)).FileVersion; } catch { return null; }
        }

        // ---------- mapping ----------

        static string TypeOf(string typeName, object kind)
        {
            if (!string.IsNullOrEmpty(typeName)) return typeName;
            switch (kind?.ToString())
            {
                case "Void": return "void";
                case "String": return "str";
                case "Integer": case "Int32": return "int";
                case "Real": return "real";
                case "Int64": return "int64";
                case "Date": return "date";
                case "UtcDateTime": case "DateTime": return "utcdatetime";
                case "Time": return "timeOfDay";
                case "Guid": return "guid";
                case "Container": return "container";
                case "AnyType": case "Anytype": return "anytype";
                case "Boolean": return "boolean";
                case null: return "anytype";
                default: return kind.ToString();
            }
        }

        static List<AttrDump> MapAttrs(IEnumerable attrs)
        {
            var r = new List<AttrDump>();
            if (attrs == null) return r;
            foreach (var a in attrs)
            {
                dynamic da = a;
                var ad = new AttrDump { Name = (string)da.Name, Args = new List<string>() };
                try { foreach (var p in da.Parameters) ad.Args.Add((string)p.TypeValue); } catch { }
                r.Add(ad);
            }
            return r;
        }

        static string? Vis(object? v) => v == null ? null : v.ToString().ToLowerInvariant();

        static ClassDump MapClass(Microsoft.Dynamics.AX.Metadata.MetaModel.AxClass c)
        {
            var d = new ClassDump
            {
                Name = c.Name,
                Extends = Nz(c.Extends),
                Implements = c.Implements?.Select(i => i.ToString()).ToList() ?? new List<string>(),
                IsAbstract = c.IsAbstract,
                IsFinal = c.IsFinal,
                IsInterface = c.IsInterface,
                IsStatic = c.IsStatic,
                IsInternal = c.IsInternal,
                IsPublic = c.IsPublic,
                IsPrivate = c.IsPrivate,
                IsObsolete = c.IsObsolete.ToString() == "Yes",
                Declaration = c.Declaration, // header + member variables; no bodies exist in a binary model
                Attributes = MapAttrs(c.Attributes),
            };
            if (c.Members != null)
                foreach (var m in c.Members)
                    d.Members.Add(new MemberDump { Name = m.Name, Type = TypeOf(m.TypeName, m.Type), Visibility = Vis(m.Visibility), IsStatic = m.IsStatic, IsReadOnly = m.IsReadOnly, IsConst = m.IsConst, IsArray = m.IsArray });
            if (c.Methods != null) foreach (var m in c.Methods) d.Methods.Add(MapMethod(m));
            return d;
        }

        static MethodDump MapMethod(Microsoft.Dynamics.AX.Metadata.MetaModel.AxMethod m)
        {
            // NOTE: m.Source is deliberately never read.
            var d = new MethodDump
            {
                Name = m.Name,
                Visibility = Vis(m.Visibility),
                IsStatic = m.IsStatic,
                IsAbstract = m.IsAbstract,
                IsFinal = m.IsFinal,
                IsDelegate = m.IsDelegate,
                IsDisplay = m.IsDisplay,
                IsEdit = m.IsEdit,
                IsExtended = m.IsExtendedMethod,
                ReturnType = m.ReturnType == null ? "void" : TypeOf(m.ReturnType.TypeName, m.ReturnType.Type),
                Attributes = MapAttrs(m.Attributes),
                Doc = string.IsNullOrWhiteSpace(m.XMLDocumentation) ? null : m.XMLDocumentation,
            };
            if (m.Parameters != null)
                foreach (var p in m.Parameters)
                    d.Parameters.Add(new ParamDump { Name = p.Name, Type = TypeOf(p.TypeName, p.Type) + (p.IsArray ? "[]" : ""), Kind = p.Type.ToString(), DefaultValue = Nz(p.DefaultValue) });
            if (m.EventHandlers != null)
                foreach (var h in m.EventHandlers) { try { d.EventHandlers.Add(h.Name); } catch { } }
            return d;
        }

        static TableDump MapTable(Microsoft.Dynamics.AX.Metadata.MetaModel.AxTable t)
        {
            var d = new TableDump
            {
                Name = t.Name, Label = t.Label, TableGroup = t.TableGroup.ToString(), PrimaryIndex = Nz(t.PrimaryIndex), ClusteredIndex = Nz(t.ClusteredIndex),
                Extends = Nz(t.Extends), IsObsolete = t.IsObsolete.ToString() == "Yes", Attributes = MapAttrs(t.Attributes),
                TableType = t.TableType.ToString(), SaveDataPerCompany = t.SaveDataPerCompany.ToString() == "Yes",
            };
            foreach (var f in t.Fields)
            {
                var fd = new FieldDump { Name = f.Name, Type = f.GetType().Name.Replace("AxTableField", ""), Edt = Nz(f.ExtendedDataType), Mandatory = f.Mandatory.ToString() == "Yes", Label = Nz(f.Label) };
                if (f is Microsoft.Dynamics.AX.Metadata.MetaModel.AxTableFieldEnum fe) fd.EnumType = Nz(fe.EnumType);
                if (f is Microsoft.Dynamics.AX.Metadata.MetaModel.AxTableFieldString fs) fd.StringSize = fs.StringSize;
                d.Fields.Add(fd);
            }
            foreach (var i in t.Indexes)
                d.Indexes.Add(new IndexDump { Name = i.Name, Unique = i.AllowDuplicates.ToString() == "No", Fields = i.Fields.Select(x => x.DataField).ToList() });
            foreach (var r in t.Relations)
            {
                var rd = new RelationDump { Name = r.Name, RelatedTable = r.RelatedTable };
                foreach (var c in r.Constraints)
                    if (c is Microsoft.Dynamics.AX.Metadata.MetaModel.AxTableRelationConstraintField cf) rd.Constraints.Add(new ConstraintDump { Field = cf.Field, RelatedField = cf.RelatedField });
                d.Relations.Add(rd);
            }
            foreach (var m in t.Methods) d.Methods.Add(MapMethod(m));
            return d;
        }

        static EdtDump MapEdt(Microsoft.Dynamics.AX.Metadata.MetaModel.AxEdt e)
        {
            var d = new EdtDump { Name = e.Name, Extends = Nz(e.Extends), Label = Nz(e.Label), BaseType = e.GetType().Name.Replace("AxEdt", ""), ReferenceTable = Nz(e.ReferenceTable) };
            if (e is Microsoft.Dynamics.AX.Metadata.MetaModel.AxEdtString s) d.StringSize = s.StringSize;
            return d;
        }

        static EnumDump MapEnum(Microsoft.Dynamics.AX.Metadata.MetaModel.AxEnum e)
        {
            var d = new EnumDump { Name = e.Name, Label = Nz(e.Label), IsExtensible = e.IsExtensible };
            foreach (var v in e.EnumValues) d.Values.Add(new EnumValueDump { Name = v.Name, Value = v.Value, Label = Nz(v.Label) });
            return d;
        }

        static string? Nz(string? s) => string.IsNullOrEmpty(s) ? null : s;
    }

    // ---------- DTOs ----------
    class ModelDump
    {
        public string? Model { get; set; }
        public string? Provider { get; set; }
        public string? ProviderFileVersion { get; set; }
        public string? SourceKind { get; set; } = "binary-isv";
        public Dictionary<string, string>? ModelInfo { get; set; }
        public List<ClassDump> Classes { get; set; } = new List<ClassDump>();
        public List<TableDump> Tables { get; set; } = new List<TableDump>();
        public List<EdtDump> Edts { get; set; } = new List<EdtDump>();
        public List<EnumDump> Enums { get; set; } = new List<EnumDump>();
        public List<string> Errors { get; set; } = new List<string>();
        public Dictionary<string, int>? Labels { get; set; }
        public Dictionary<string, int>? Exported { get; set; }
        public List<CocClass>? ChainOfCommand { get; set; }
        public PlatformDump? Platform { get; set; }
        public UnresolvedDump? Unresolved { get; set; }
    }
    class PlatformDump { public string? ProviderFileVersion { get; set; } public string? PackagesPath { get; set; } public Dictionary<string, string>? Modules { get; set; } public List<string>? MissingModules { get; set; } }
    class UnresolvedDump { public int Checked { get; set; } public int Count { get; set; } public List<string> Examples { get; set; } = new List<string>(); }
    class AttrDump { public string? Name { get; set; } public List<string>? Args { get; set; } }
    class ParamDump { public string? Name { get; set; } public string? Type { get; set; } public string? Kind { get; set; } public string? DefaultValue { get; set; } }
    class MethodDump
    {
        public string? Name { get; set; } public string? Visibility { get; set; }
        public bool IsStatic { get; set; } public bool IsAbstract { get; set; } public bool IsFinal { get; set; }
        public bool IsDelegate { get; set; } public bool IsDisplay { get; set; } public bool IsEdit { get; set; } public bool IsExtended { get; set; }
        public string? ReturnType { get; set; }
        public List<ParamDump> Parameters { get; set; } = new List<ParamDump>();
        public List<AttrDump>? Attributes { get; set; }
        public List<string> EventHandlers { get; set; } = new List<string>();
        public string? Doc { get; set; }
    }
    class MemberDump { public string? Name { get; set; } public string? Type { get; set; } public string? Visibility { get; set; } public bool IsStatic { get; set; } public bool IsReadOnly { get; set; } public bool IsConst { get; set; } public bool IsArray { get; set; } }
    class ClassDump
    {
        public string? Name { get; set; } public string? Extends { get; set; } public List<string>? Implements { get; set; }
        public bool IsAbstract { get; set; } public bool IsFinal { get; set; } public bool IsInterface { get; set; } public bool IsStatic { get; set; }
        public bool IsInternal { get; set; } public bool IsPublic { get; set; } public bool IsPrivate { get; set; } public bool IsObsolete { get; set; }
        public string? Declaration { get; set; }
        public List<AttrDump>? Attributes { get; set; }
        public List<MemberDump> Members { get; set; } = new List<MemberDump>();
        public List<MethodDump> Methods { get; set; } = new List<MethodDump>();
    }
    class FieldDump { public string? Name { get; set; } public string? Type { get; set; } public string? Edt { get; set; } public string? EnumType { get; set; } public bool Mandatory { get; set; } public string? Label { get; set; } public int? StringSize { get; set; } }
    class IndexDump { public string? Name { get; set; } public bool Unique { get; set; } public List<string>? Fields { get; set; } }
    class ConstraintDump { public string? Field { get; set; } public string? RelatedField { get; set; } }
    class RelationDump { public string? Name { get; set; } public string? RelatedTable { get; set; } public List<ConstraintDump> Constraints { get; set; } = new List<ConstraintDump>(); }
    class TableDump
    {
        public string? Name { get; set; } public string? Label { get; set; } public string? TableGroup { get; set; } public string? PrimaryIndex { get; set; } public string? ClusteredIndex { get; set; }
        public string? Extends { get; set; } public bool IsObsolete { get; set; } public string? TableType { get; set; } public bool SaveDataPerCompany { get; set; }
        public List<AttrDump>? Attributes { get; set; }
        public List<FieldDump> Fields { get; set; } = new List<FieldDump>();
        public List<IndexDump> Indexes { get; set; } = new List<IndexDump>();
        public List<RelationDump> Relations { get; set; } = new List<RelationDump>();
        public List<MethodDump> Methods { get; set; } = new List<MethodDump>();
    }
    class EdtDump { public string? Name { get; set; } public string? Extends { get; set; } public string? Label { get; set; } public string? BaseType { get; set; } public string? ReferenceTable { get; set; } public int? StringSize { get; set; } }
    class EnumValueDump { public string? Name { get; set; } public int Value { get; set; } public string? Label { get; set; } }
    class EnumDump { public string? Name { get; set; } public string? Label { get; set; } public bool IsExtensible { get; set; } public List<EnumValueDump> Values { get; set; } = new List<EnumValueDump>(); }
}
