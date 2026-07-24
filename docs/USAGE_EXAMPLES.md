# Usage Examples

Five full-stack scenarios showing what to *ask* — the agent runs the grounded MCP tool chain automatically. Each spans the whole AOT stack (EDTs/enums → tables → forms → logic → menu items → security) with labels in three languages. You only write the prompt.

## Model selection at a glance

| Work shape | Recommended | Why |
|------------|-------------|-----|
| Pure discovery — search, `get_object_info`, label/where-used lookups | **Haiku** | Recall, not reasoning. Cheapest, sub-second. |
| Standard generation — one table, a cloned form, a CoC class, an SSRS report | **Sonnet** | Best value. Handles the grounding chain reliably. **Default.** |
| Architecture-heavy — greenfield modules, financial posting, cross-cutting CoC | **Opus** | Multi-object reasoning pays for itself in fewer compile-fix loops. |

Rule of thumb: **discover on Haiku, build on Sonnet, architect on Opus** — switching mid-conversation is fine.

> The **Measured run** numbers below are from real end-to-end runs on the eval sandbox (Claude Sonnet, ≈580K symbols / 20M label rows); **indicative** ranges are ballpark budgets to plan against — verify on your own metadata. *New context* = fresh tokens the tools pour in (tool results dominate input cost); *billed total (cached)* assumes prompt caching on.

---

## 1 — Greenfield module: Equipment Rental

Building a functional area from nothing — the most demanding shape.

```
Build the foundation of an Equipment Rental module in model EquipRental.
Equipment master (RentEquipmentId number-seq keyed, Name, Category/Status enums,
DailyRate) and a rental agreement (header + lines). Use the right form patterns,
wire number sequences the way this codebase does, add display menu items + a submenu,
and maintenance + view security roles. Label everything in en-US, cs and de.
```

Touches EDTs, enums, four tables, three forms (DetailsMaster/DetailsTransaction/TableOfContents), navigation and security.

**Key gotchas**
- Creation order follows dependencies: EDTs/enums → tables → forms → menu items → menu.
- Number sequences are codebase-specific — let `generate_object(pattern="number-seq-handler")` match *your* model's wiring.
- Build after *every* new object during a greenfield slice; cap remediation at 2–3 tries before rolling back, rather than patching a defect forward.

> **Measured run:** ~230 tool calls (~195 MCP + ~35 host) · sub-agent context **~411K tokens** · 28 objects + 47 labels created, ultimately 0 delivered (a genuine defect triggered a full rollback) · ~15 builds. The costliest scenario — the run over-invested in one defect, which is exactly why the 2–3-try cap matters.
> **Model: Opus** — multi-object reasoning where one wrong type cascades.

---

## 2 — Extending standard posting: sales credit review + audit

Safely changing Microsoft code — the most common real-world shape.

```
Before SalesFormLetter_Confirm posts, enforce a credit-review check and log every
attempt. First check whether SalesFormLetter.run is already wrapped by CoC and get the
exact signature. Add CreditReviewDate + CreditReviewedBy to CustTable (table extension).
Create audit table SalesPostingAuditLog with proper EDTs. Generate the CoC class that
blocks posting when review is needed and inserts an audit row either way. Add an audit
inquiry form + menu item under Accounts receivable > Inquiries, and a duty extension.
```

**Key gotchas**
- `extension_info(mode="coc")` **first, always** — a second wrapper around an already-wrapped method is the #1 CoC defect (double posting side-effects).
- The grounding token from `prepare(mode="change")` is bound to the method — the write tools reject a token issued for a different object.
- A table extension goes through the bridge's `IMetadataProvider` — a clean `CustTable.<Model>Extension` delta, no risk of corrupting the standard table.

> **Cost (indicative):** ~30–42 tool calls · ~70–110K new context · ~18–28K output · ~140–230K billed (cached).
> **Measured run:** ~150 tool calls (~112 MCP + ~38 host) · 12 objects, build-clean · 4 builds (3 fail → pass).
> **Model: Opus** (Sonnet if the posting logic is simple).

---

## 3 — Operational feature: vendor certificate compliance

The classic "table + SysOperation batch + SSRS" trio.

```
Create vendor certificate compliance in model VendCompliance. Table VendCertificate
(VendAccount, CertType/Status enums, IssueDate, ExpiryDate). SimpleListDetails form.
A SysOperation nightly batch that flags certs ExpiringSoon within 30 days and Expired
past ExpiryDate, with a labelled DataContract threshold parameter. An SSRS report
grouped by CertType. Menu items under Procurement > Inquiries. A privilege + role.
```

**Key gotchas**
- Clone the SysOperation shape from your own model via `analyze_code(mode="patterns", scope="extensions")`.
- Set enum ordinals explicitly — omitting values silently defaults every member to `0` (duplicate-value compile error).
- Report scaffold order is load-bearing: TmpTable → Contract → DP → Controller. "Grouped by X" groups on the first hint field — check the RDL `GroupExpression`.

> **Cost (indicative):** ~35–48 tool calls · ~80–120K new context · ~22–32K output · ~150–260K billed (cached).
> **Measured run:** ~164 tool calls (~113 MCP + ~51 host) · 19 objects, build-clean · 13 build calls, 7 failed before the final pass.
> **Model: Sonnet** — well-trodden patterns.

---

## 4 — Cross-stack enhancement: customer priority-tier discounts

The lightweight full-stack path — small surface, every layer touched.

```
Add a customer priority tier discount in model CustLoyalty. Enum CustPriorityTier
(Standard, Silver, Gold, Platinum) added to CustTable and surfaced on the General tab.
Setup table CustTierDiscount mapping tier to a discount percent, with a SimpleList form
and a menu item under Accounts receivable > Setup. A CoC extension on the sales line
discount calc that applies the tier percent. A privilege wired into the AR setup duty.
```

**Key gotchas**
- `get_object_info(form, {searchControl})` resolves the *exact* parent control before `add-control` — guessing corrupts form XML.
- Table CoC `next` differs from class CoC: use `next modifiedField(_fieldId)`, not `next(_fieldId)`.
- Find a duty by its privilege (`security_info(mode="artifact", privilege=...)` reverse-lookup) rather than guessing duty names.

> **Cost (indicative):** ~22–32 tool calls · ~45–75K new context · ~12–20K output · ~90–160K billed (cached) — the cheapest full-stack scenario.
> **Measured run:** ~150 tool calls (~95 MCP + ~55 host) · 9 objects, build-clean · 2 builds (1 fail → pass).
> **Model: Sonnet** for the build, **Haiku** for the discovery turns.

---

## 5 — Integration & analytics: inventory aging entity + report

The data-out shape: surface existing data for OData, Excel and SSRS.

```
Build inventory aging analytics in model InventAnalytics. A view over InventSum/InventTrans
bucketing on-hand value into 0-30/31-60/61-90/90+ day buckets. A public OData data entity
over that view. An SSRS report with a dialog (InventLocationId mandatory, AsOfDate). Menu
items under Inventory management > Inquiries and a view-only role. Walk me through the
InventSum/InventTrans structure first so the buckets are correct.
```

**Key gotchas**
- Understand the source first: `get_object_info(table)` on `InventSum`/`InventTrans` before bucketing.
- A view's computed columns are static SQL — runtime parameters (`AsOfDate`) must live in the report's DP class, not the view.
- `generate_object(objectType="form")` targets tables, not views.

> **Cost (indicative):** ~28–40 tool calls · ~60–100K new context · ~16–26K output · ~120–210K billed (cached).
> **Measured run** (inspect + repair — objects already built from an earlier session): ~52 tool calls (~32 MCP + ~20 host, host-heavy from raw-XML cross-checks) · ~17 objects · 3 builds, all 0 errors / 0 warnings.
> **Model: Sonnet** for the report, **Haiku** for the source-structure walkthrough.
