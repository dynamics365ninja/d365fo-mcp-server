# L3-parallel-batch-tasks — golden notes

**Status: FROZEN.** All three required deliverables were written through the grounded
tool path and verified on the VM, so `golden_pending` is `false` in
`eval/cases/L3-parallel-batch-tasks.json`.

Captured 2026-07-29, server SHA `d1ccb46`, xppc 7.0.7858.27, model `Contoso`,
`EXTENSION_PREFIX=Con`.

| Artifact | Role |
|---|---|
| `ConDemoParallelContract.metadata.xml` | `[DataContractAttribute]` contract, two `[DataMemberAttribute]` `parm` methods over the bundle's from/to `NoteId`. Scalar `Num` members only — serializable, no `List`/`Map`. |
| `ConDemoParallelWorker.metadata.xml` | SysOperation service; `[SysEntryPointAttribute] public void processBundle(ConDemoParallelContract _contract)` selects **only** the contract's `NoteId` range. |
| `ConDemoParallelScheduler.metadata.xml` | `public static void scheduleAll()` — `BatchHeader::construct()`, one `addRuntimeTask(SysOperationServiceController, inheritFromTaskId)` per bundle, then `save()`. The work is **not** done inline. |

## Grounded signatures (all read off the real AOT before writing)

- `static BatchHeader construct(recId _batchJobId = 0)`
- `void addRuntimeTask(Batchable batchTask, recId inheritFromTaskId, BatchConstraintType constraintType = BatchConstraintType::And)`
- `void save(BatchStatus status = BatchStatus::Waiting)`
- `public BatchCaption parmCaption(BatchCaption _caption = caption)` (on both `BatchHeader` and `BatchInfo`)
- `public static Batch getCurrentBatchTask()` — documented to return *an empty record* when not in batch, so `.RecId` is safe
- `SysOperationServiceController.new(IdentifierName _className='', IdentifierName _methodName='', SysOperationExecutionMode _executionMode = SysOperationExecutionMode::Asynchronous)`
- `public Object getDataContractObject(IdentifierName _parameterName = '')`

## Negative proof that the clean build is meaningful

A throwaway probe class was compiled and then removed. The full build failed exactly
as designed, which is what makes `build: 1` on the real artifacts evidence rather than
noise:

```
Type mismatch in 'BatchHeader.addRuntimeTask' argument 1.
  The expected type is 'Batchable', but the actual type is 'ConDemoParallelContract'.
The instance method designated by argument 'processBundleDoesNotExist' does not exist.
```

So the compiler really does enforce `Batchable` on argument 1 (i.e. the fan-out via
`SysOperationServiceController` is genuine) and really does resolve
`methodStr(ConDemoParallelWorker, processBundle)`.

## Accepted BP warning (`bp_clean: 0`, **0 BP errors**)

`BPUpgradeCodeSysEntryPointAttribute` on `ConDemoParallelWorker.processBundle`
("SysEntryPoint attribute has been deprecated"). xppc emits the same thing as a
compile warning. It is **mandated verbatim by the case instruction**, so it cannot be
removed without failing the case. The harness's `bp_clean` counts warnings of any
severity, hence `0`; the case's own gate — zero BP *errors* — is met.

## Reproduction caveat: labels must be compiled separately

The classes reference `@Contoso:DemoParallel*` labels created with
`labels(action="create")`. `build_d365fo_project` does **not** run `labelc.exe`, so the
labels are never compiled into `Contoso/Resources/Contoso.dll` and xppbp reports
`BPErrorUnknownLabel` plus cascading bogus `BPUnusedStrFmtArgument` warnings. Until
that gap is closed in the server, a re-run must compile labels out of band:

```
bin\labelc.exe -metadata="K:\AosService\PackagesLocalDirectory" ^
               -output="K:\AosService\PackagesLocalDirectory\Contoso\Resources" ^
               -modelmodule="Contoso"
```

(the exact command Visual Studio records in `HBReavis/CompileLabels.xml`). Doing so
removed all six label-related warnings with no source change — see the
`TOOL_DEFECT` record `eval/corpus/runs/2026-07-29T07__L3-parallel-batch-tasks__d1ccb46.json`.

## Fixture

`ConDemoNoteHeader` is a harness INPUT fixture (`eval/fixtures/`). It is read by the
worker and the scheduler and is **kept** by the rollback — this case neither creates
nor deletes it.
