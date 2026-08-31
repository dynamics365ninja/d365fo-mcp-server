# Offline oracle corpus

What `scripts/oracles/*.ts --dry` reads when there is no D365FO install: a handful
of AOT files in the platform's layout (`<AxType>/<Name>.xml`, X++ inside CDATA).

**What belongs here.** Minimal reproductions of shapes that were *measured* on the
shipped source — above all, the five that produced error-severity false positives
before the shared lexer landed (a comma inside `','`, a GUID mask's `??`, SQL text
in a literal, a CoC class's new method with default parameters, a static
extension-method class), plus the awkward literals the lexer has to mask.

That makes the corpus a regression test with a hard bar: **`npm run oracle:sweep --
--dry` must report zero error-severity findings.** A rule that fires here would
have fired on Microsoft's code.

**What does not belong here.** Copies of Microsoft's source (this is our own X++,
written to the same shapes), and invented shapes nobody writes — a fixture that no
shipped code matches tests our imagination, not the language. Add a file only
together with the census or probe run that showed the shape is real, and say so in
the class's doc comment.

**These files are never compiled.** They exercise the regex rules and the lexer,
which is why they may reference application tables (`CustTable`, `CustTrans`)
without the model that owns them. The compile-truth half of the same question is
`scripts/oracles/xppcProbe.ts`, which runs on the VM against real `xppc`.
