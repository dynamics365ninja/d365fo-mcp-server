# Comparing two versions of a model

`npm run diff-metadata` answers "what changed in this model between update A and update B" from two
extracted-metadata directories: the added, removed and changed classes, methods, tables, fields, EDTs and
enum values, and which methods and classes gained `[SysObsolete]`.

```
npm run diff-metadata -- <metadataDirFrom> <metadataDirTo> [--models A,B] [--json out.json] [--examples 5]
```

Both directories are what `extract-metadata` writes (`<dir>/<Model>/{classes,tables,edts,enums}/*.json`),
or what `extract-binary-models` writes for a model that ships without source (binary ISV models). The two
shapes are read the same way, so a source model can be compared with its own earlier version, and so can
a binary ISV model. Extract each version into its own directory (`METADATA_PATH=...`), then compare. Models
present in both directories are compared; models present in only one are listed.

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
