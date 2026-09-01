# Golden: L3-form-detailstransaction

## Hand-correction 2026-09-01: the writer changed under this golden

PR #984 fixed two defects in the form pattern templates, and this golden was
captured before them — so it asserted the OLD, defective output as the expected
answer, and a faithful rerun would have scored `golden_match: 0` against its own
correct result.

Changed here, mechanically and by hand (NOT a re-capture):

- `Header` → `@SYS101051`, `Lines` → `@SYS15451`, `Line details` → `@SYS23823`, `General` ×2 → `@SYS2952`

Both transformations are deterministic consequences of the writer fix, which is
why they were applied rather than re-captured:

- **Captions.** `<Caption>` holding raw text is `BPErrorLabelIsText`, and
  untranslatable. Each replacement id is the exact text in ApplicationPlatform's
  `SYS.en-us.label.txt` and the most-used caption of that wording across a census
  of shipped Foundation forms (#980).
- **Element order.** AOT XML is order-sensitive and the deserializer drops a
  misplaced element in silence: with `<DataGroup>`/`<DataSource>` above
  `<Controls>`, the metadata provider read the group with NO children. Verified
  against the live provider on the VM — same file, only those two lines moved:
  14 controls before, 16 after (#979).

`tests/eval/goldenFormIntegrity.test.ts` now fails on either shape, so a golden
captured from a defective writer cannot enshrine the defect again.
