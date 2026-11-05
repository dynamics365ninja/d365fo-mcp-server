# Comparing two versions of a model

`npm run diff-metadata` answers "what changed in this model between update A and update B" from two
extracted-metadata directories: the added, removed and changed classes, methods, tables, fields, EDTs and
enum values, and which methods and classes gained `[SysObsolete]`.

```
npm run diff-metadata -- <metadataDirFrom> <metadataDirTo> [--models <mask>] [--json out.json] [--examples 5]
```

Both directories are what `extract-metadata` writes (`<dir>/<Model>/{classes,tables,edts,enums}/*.json`),
or what `extract-binary-models` writes for a model that ships without source (binary ISV models). The two
shapes are read the same way, so a source model can be compared with its own earlier version, and so can
a binary ISV model. Extract each version into its own directory (`METADATA_PATH=...`), then compare. Models
present in both directories are compared; models present in only one are listed.

### Choosing models

`--models` (and `--deps` of `upgrade-impact`) take comma-separated names and masks: `Contoso*`, `ContosoApp_*,Fabrikam*`,
`*,!ContosoDemo*`. A leading `!` excludes, a spec with only exclusions starts from every model, `*` and `?` are
the only wildcards and case is ignored. A mask matches the module name (the folder in the extract) or the
display name ("Contoso Core") that a binary-ISV record carries. Models selected on only one side are listed
and not compared.

## What counts as a change

| Object | Compared |
|---|---|
| Class | presence; base class, `final`/`abstract`/`internal`, attributes in front of the declaration |
| Method | presence; visibility, `static`, return type, name, parameters (type, name, default), attributes |
| Table | presence; field presence; field type and EDT or enum |
| EDT | presence; base EDT and string size |
| Enum | presence; value names |

A method's attributes are read from the `attributes` list a binary model carries, or from the lines in
front of the declaration in the stored method source. An attribute-only change is a changed signature
(`[SuppressBPWarning]` added to an event handler is common after an update); `newly obsolete` lists the
methods and classes that gained `[SysObsolete]`, because those are the ones to act on first.

## Output

A summary per model, then the first `--examples` changed signatures as before and after:

```
~ ContosoPrinter.print
    - public boolean print(int _copies = 1, str _name)
    + public boolean print(int _copies)
```

`--json` writes the full lists for further processing (what to re-test, which wrappers to review).

## Limits

- Method bodies are not compared. A changed body with an unchanged signature is not reported.
- Tables are compared by fields; indexes, relations, field groups and table methods are not.
- Extensions of other models' objects (table, form, data entity extensions) are not compared.
- The comparison reads what the extract wrote. An extract of a binary model has no bodies, so for such
  models the signature is all there is.

## Upgrade impact

`npm run upgrade-impact` checks whether **your own** models survive the next version of the models they
depend on, without a build. It reads the same extracted-metadata directories as `diff-metadata`: one per
version of the dependencies, plus the extract of your models.

```
npm run upgrade-impact -- --from <metadataDirOld> --to <metadataDirNew> --models 'ContosoExt,ContosoCore' \
  [--ours <metadataDirWithYourSource>] [--deps <mask>] [--out report.md] [--json report.json]
```

`--models` selects your models (names and masks, see *Choosing models*); their source is read from `--ours` (default `--from`) and compared against both
versions of everything else. Only the dependency models present in **both** directories are compared; a model
present in only one is listed as "not compared", never reported as removed, because a missing module is a gap
in the extract rather than a breaking change. The exit code is 1 when anything will not compile.

The report has two parts: what changed in the dependencies (the `diff-metadata` summary) and, per object of
yours, what breaks, where (method and line inside the stored method source), what it was, what it is now and
how to fix it. Findings are classified:

| Level | Meaning | Examples |
|---|---|---|
| `error` | will not compile | a called method removed, made private or static, a required parameter added, a parameter or return type changed; a field or enum value removed; a used class removed; `[SysObsolete]` with the error flag; a wrapper whose base method was removed, became `final` or `[Wrappable(false)]`, or changed signature; a `[SubscribesTo]` handler whose delegate was removed, changed parameters or lost `[Hookable]`; an override of a method that became `final` or changed signature |
| `behaviour` | compiles, does something else | an override whose base method was removed (it is never called); a Chain of Command wrapper of a method the dependency stopped declaring but the type still inherits (the wrapper compiles and now wraps the inherited method; whatever logic the dependency had in its own version is gone); a field that now uses another EDT or enum; an EDT whose size or base changed |
| `warning` | compiles and runs | `[SysObsolete]`; a new optional parameter |

Two layers produce them. The first runs the resolver behind `validate_code(mode="references")` against an
index of the old and an index of the new dependency models and keeps what is new against the new one. The second
uses the diff for what name resolution cannot see: the wrapper must repeat the base signature, the handler
must match its delegate, the arguments of a call must fit the new parameters, a field's type changed.

### Platform update

When the update is a new Microsoft platform or application build, the models that change are Microsoft's, and
your installed models (ISVs and customer models alike) are the ones to check:

```
npm run upgrade-impact -- --platform-upgrade --from-pld <oldPackagesLocalDirectory> --to-pld <newPackagesLocalDirectory> \
  --ours <metadataDirWithOurModels> --models 'Contoso*,Fabrikam*' [--cache <dir>] [--out report.md]
```

The two PLDs hold the Microsoft models as XML. Extracting all of them is not needed: the command collects every
name your models use, finds those objects in each PLD by file name, follows what they inherit from or are typed
with (`extends`, `implements`, EDT and enum types of fields) and cuts just that out into `--cache`, where the
stock `extract-metadata` reads it. The report for that cut-out is the usual one; the "changed in the
dependencies" counts then describe what your models touch, not the whole platform (a class added to the
platform is never listed). The cut-out stays in `--cache`, so another report over the same dependencies needs
no new slicing:

```
npm run upgrade-impact -- --from <cache>/from --to <cache>/to --ours <dir> --models 'Fabrikam*'
```

`--kernel-from <dir> --kernel-to <dir>` name the directories that hold `Kernel` for each PLD (see below).

Slicing reads the file names of the whole PLD and takes about a minute per PLD; extraction and the check take
a few seconds to a minute. The run time of each step is printed at the end of the report.

**Models without method bodies.** A compiled ISV model has signatures but no bodies. For it the check covers
signatures, overrides, Chain of Command wraps (from the compiler's record), inheritance and the types of fields
and parameters; calls, field accesses and event-handler attributes inside its methods are not visible, and the
report says so. A model extracted from source is checked in full.

### Methods are resolved through the hierarchy

A method is looked up the way the compiler does: a class through `extends` (and `implements`) up to `Object`, a
table through its base table up to `Common`, always in the compared metadata and never from a list in the tool.
A removed or changed method is therefore judged on the **effective** member of the type:

- still available from an ancestor with a compatible signature: not a breakage. If the type itself declared it
  before and only inherits it now, that is a fact about the dependency ("`SalesLine.update` is no longer
  overridden, now inherited from `Common`"), listed under *what changed in the dependencies* with the objects of
  yours that rely on it. A wrapper of that method is a `behaviour` finding; a plain call is only listed as
  *affected, no action implied*;
- available from an ancestor with an incompatible signature: reported as the usual signature break;
- gone from the whole hierarchy: removed (`error`);
- the hierarchy leaves the compared metadata (an ancestor that was not extracted): nothing can be said, the call
  or wrapper is listed as *affected* with the name of the missing ancestor.

The ancestors of tables and classes that live in the kernel (`Common`, `xRecord`, `Object`, ...) have no XML in a
PLD. Dump them with `BinaryModelExtractor --kernel` for each platform build and give them to the check as the
model `Kernel`: copy `<dump>/Kernel` into the extracted-metadata directories, or pass the directory that holds it
with `--kernel-from` and `--kernel-to` in `--platform-upgrade`. Without it the hierarchy of every table ends at
a missing `Common` and such findings stay *affected*.

### Reading a report

- The `Checked …` line says how many calls, wrappers, handlers and field accesses of yours could be placed
  against the compared dependencies. A clean report with small numbers there mostly says that your code uses
  other models (Microsoft's, for instance) that were not part of the comparison.
- Calls are found by scanning the stored method source: `Type::method(...)`, `variable.method(...)` with
  the variable's declared type, `this.method(...)`. A call whose receiver cannot be typed is not reported.
- A name that did not exist in the old version is never reported as broken. If your code was written against
  a newer version than `--from`, extract that version as `--from`.
- Extract your models and every version of the dependencies with the same model set. Comparing different
  sets turns every dependency that is merely missing from one side into noise.

### Limits

- Method bodies of the dependencies are not compared, so a changed behaviour behind an unchanged signature is
  invisible. Neither are forms, data entity and query changes, or security objects.
- Inherited members are followed only through classes inside the compared models.
- Results are findings to review, not a compiler: a `param-type` finding means the argument may no longer be
  accepted, not that it certainly is not.
