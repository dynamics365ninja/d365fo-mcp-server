/**
 * Warehouse-app screen patterns — how to CREATE and MODIFY one screen of a
 * mobile device flow, in whichever of the two frameworks owns it.
 *
 * Grounded in Microsoft's own developer documentation for the process guide
 * framework (dynamics365/supply-chain/supply-chain-dev/process-guide-framework)
 * and for the app's step identity (warehousing/step-icons-titles), so the class
 * names, attributes and method names below are the documented ones rather than
 * recalled ones. Every AOT name is still worth confirming with
 * get_object_info against the installed version before it is written: the
 * catalog says WHAT to build, the index says whether this deployment has it.
 *
 * The skeletons are gated: tests/knowledge/mobileAppPatternCatalog.test.ts runs
 * every one through the same offline best-practice validator that backs
 * validate_code(mode="syntax"), because a template that emits BP-failing X++ is
 * worse than no template (docs/KNOWLEDGE_AUTHORING.md §4).
 */

import type { MobileAppPatternSpec } from './types.js';

const CONFIRM_FIRST =
  'Confirm every class, attribute and member named here against the installed version ' +
  '(search + get_object_info) before writing — the ProcessGuide surface has grown release by ' +
  'release and a flow converted in 10.0.x may still be legacy in an older deployment.';

const BUILD_CHECKS = [
  'validate_code(mode="references") on each new class — every base class and attribute must resolve in the index.',
  'validate_code(mode="syntax") — labels not literals (BPErrorLabelIsText), meaningful doc comments (BPXmlDocNoDocumentationComments).',
  'build_d365fo_project — an attribute that does not exist, or a step name that no class carries, fails at compile, not at run time.',
  'Exercise the flow from the app (or a SysTest driving the controller): a screen that builds but never appears is the normal failure here.',
];

export const MOBILE_APP_PATTERN_CATALOG: MobileAppPatternSpec[] = [
  // ── ProcessGuide: build a whole flow ──────────────────────────────────────
  {
    id: 'processguide-flow',
    displayName: 'New flow (process guide framework)',
    aliases: ['new-flow', 'process-guide', 'custom-flow', 'create-screen'],
    framework: 'process-guide',
    purpose:
      'Build a complete multi-screen mobile flow: a controller that owns the process, one step per ' +
      'screen, a page builder per step, and a navigation route that wires them together.',
    whenToUse: [
      'A new mobile device menu item that walks a worker through several screens',
      'Any new flow in a version that carries the ProcessGuide classes — this is the framework Microsoft extends',
      'The process spans production or inventory rather than warehouse work (the framework deliberately drops the WHS prefix)',
    ],
    whenNotToUse: [
      'You are changing ONE screen of an existing flow — use processguide-page-control or processguide-page-replace instead',
      'The flow you must touch is still a WHSWorkExecuteDisplay subclass — see legacy-workexecutedisplay',
    ],
    objects: [
      {
        role: 'Controller',
        naming: '{Area}ProcessGuide{Process}Controller',
        baseOrType: 'class extends ProcessGuideController, [WHSWorkExecuteMode(WHSWorkExecuteMode::{Mode})]',
        notes: 'Owns the whole process. The WHSWorkExecuteMode attribute is how SysExtension finds it when the worker opens the menu item — the same instantiation the legacy display classes use.',
      },
      {
        role: 'Step (with a screen)',
        naming: '{Area}ProcessGuide{What}Step',
        baseOrType: 'class extends ProcessGuideStep, [ProcessGuideStepName(classStr({Area}ProcessGuide{What}Step))]',
        notes: 'One step = one screen. Names its page builder and decides when it is complete.',
      },
      {
        role: 'Page builder',
        naming: '{Area}ProcessGuide{What}PageBuilder',
        baseOrType: 'class extends ProcessGuidePageBuilder, [ProcessGuidePageBuilderName(classStr({Area}ProcessGuide{What}PageBuilder))]',
        notes: 'Builds the screen: addDataControls() for fields/labels, addActionControls() for buttons, or addControls() when the two must interleave.',
      },
      {
        role: 'Step (no screen)',
        naming: '{Area}ProcessGuide{Action}Step',
        baseOrType: 'class extends ProcessGuideStepWithoutPrompt',
        notes: 'The step that DOES the work. Runs silently after the prompt screen; override doExecute() and call addProcessCompletionMessage() so the next screen shows "Work completed".',
      },
      {
        role: 'Mobile device menu item',
        naming: '(setup)',
        baseOrType: 'configured data — Warehouse management > Setup > Mobile device > Mobile device menu items',
        notes: 'NOT an AOT element. The menu item is what points a worker at the mode your controller is registered for.',
      },
    ],
    skeletons: [
      {
        label: 'Controller — the process, its first step and its route',
        code: `/// <summary>
/// Guides a worker through the demo pack process on the mobile device: prompt
/// for a container, then register the pack.
/// </summary>
[WHSWorkExecuteMode(WHSWorkExecuteMode::MyDemoPack)]
public class MyDemoProcessGuidePackController extends ProcessGuideController
{
    protected ProcessGuideStepName initialStepName()
    {
        return classStr(MyDemoProcessGuidePromptContainerStep);
    }

    protected ProcessGuideNavigationRoute initializeNavigationRoute()
    {
        ProcessGuideNavigationRoute navigationRoute = new ProcessGuideNavigationRoute();

        // A route is a plain map of "after this step, that step". Conditional
        // branching needs its own navigation agent instead - see methodNotes.
        // Every classStr() here is compile-time checked, so the route may name
        // ONLY steps this flow actually creates: an edge through a confirm step
        // you have not written does not compile, and there is no reusable
        // framework confirm step to borrow (every ProcessGuide*Confirm*Step in
        // the product is process-specific, with its own page builder).
        navigationRoute.addFollowingStep(classStr(MyDemoProcessGuidePromptContainerStep), classStr(MyDemoProcessGuideRegisterPackStep));
        navigationRoute.addFollowingStep(classStr(MyDemoProcessGuideRegisterPackStep), classStr(MyDemoProcessGuidePromptContainerStep));

        return navigationRoute;
    }
}`,
      },
      {
        label: 'Step + page builder — one screen that prompts for a value',
        code: `/// <summary>
/// Represents the screen that asks the worker to scan a container.
/// </summary>
[ProcessGuideStepName(classStr(MyDemoProcessGuidePromptContainerStep))]
public class MyDemoProcessGuidePromptContainerStep extends ProcessGuideStep
{
    protected ProcessGuidePageBuilderName pageBuilderName()
    {
        return classStr(MyDemoProcessGuidePromptContainerPageBuilder);
    }

    /// <summary>
    /// The step is done once the pass-through state carries a container id.
    /// </summary>
    protected boolean isComplete()
    {
        WhsrfPassthrough pass = controller.parmSessionState().parmPass();

        return pass.lookup(ProcessGuideDataTypeNames::ContainerId) != '';
    }
}

/// <summary>
/// Builds the screen that asks the worker to scan a container.
/// </summary>
[ProcessGuidePageBuilderName(classStr(MyDemoProcessGuidePromptContainerPageBuilder))]
public class MyDemoProcessGuidePromptContainerPageBuilder extends ProcessGuidePageBuilder
{
    protected void addDataControls(ProcessGuidePage _page)
    {
        // The control name doubles as the step id the app uses for icon and
        // title - see the app-step-identity pattern before inventing one.
        _page.addTextBox(ProcessGuideDataTypeNames::ContainerId, "@WAX:MyDemoScanContainer", extendedTypeNum(WHSContainerId));
    }

    protected void addActionControls(ProcessGuidePage _page)
    {
        #ProcessGuideActionNames

        _page.addButton(step.createAction(#ActionOK), true);
        _page.addButton(step.createAction(#ActionCancelExitProcess));
    }
}`,
      },
      {
        label: 'Silent step — the action itself, then the completion message',
        code: `/// <summary>
/// Registers the pack for the scanned container. Runs without a screen, right
/// after the worker confirms.
/// </summary>
[ProcessGuideStepName(classStr(MyDemoProcessGuideRegisterPackStep))]
public class MyDemoProcessGuideRegisterPackStep extends ProcessGuideStepWithoutPrompt
{
    protected final void doExecute()
    {
        WhsrfPassthrough pass = controller.parmSessionState().parmPass();

        // The business action belongs in a service class: this step is one
        // caller of it, an integration or a SysTest is another. Anything that
        // throws here is rolled back by the framework to the previous step.
        MyDemoPackService::registerPack(pass.lookup(ProcessGuideDataTypeNames::ContainerId));

        this.addProcessCompletionMessage();

        super();
    }
}`,
      },
    ],
    methodNotes: [
      'Controller: override initialStepName() (the first screen) and initializeNavigationRoute() (the map). Those two are the whole controller for a linear flow.',
      'Step: override pageBuilderName() always; override isComplete() when the screen collects a value — the base marks a screen complete on OK alone, which silently skips your validation.',
      'Page builder: addDataControls() for text boxes and labels, addActionControls() for buttons; override addControls() only when data and buttons must interleave.',
      'Every control carries a data-type name (ProcessGuideDataTypeNames) and an EDT via extendedTypeNum — the EDT is what gives the field its lookup, formatting and validation on the device.',
      'Validation failures need no code: the base page builder rebuilds the screen, clears the scanned value and adds the error control. Override rebuildFromRequestPage(), isErrorState() or reuseRequestPageOnError() only to deviate.',
      'User input is processed by ProcessGuideDataProcessorDefault, which delegates to the legacy WhsRfControlData — standard fields (item, location, license plate) are already validated there, so write a data processor only for a field the platform does not know.',
      'Buttons are actions: #ActionOK, #ActionCancelExitProcess and #ActionCancelResetProcess come from the #ProcessGuideActionNames macro. A custom button is a ProcessGuideAction subclass carrying [ProcessGuideActionName] with label() and doExecute().',
      'Conditional branching: subclass ProcessGuideNavigationAgent plus a factory from ProcessGuideNavigationAgentAbstractFactory, and override navigationAgentFactory() in the controller. Do not fake a branch by mutating the route.',
      'State lives in the pass-through (WhsrfPassthrough via controller.parmSessionState().parmPass()), never in class members: the next round trip may be served by another AOS.',
      CONFIRM_FIRST,
    ],
    crossChecks: [
      ...BUILD_CHECKS,
      'The mode on the controller attribute must be a real WHSWorkExecuteMode value — a custom one is an enum extension (get_knowledge(topic="extensible-enums")).',
      'Give each new screen its step identity (icon/title) or it shows the app default — see the app-step-identity pattern.',
    ],
    referenceElements: [
      'ProdProcessGuideProductionStartController',
      'ProdProcessGuidePromptProductionIdStep',
      'ProdProcessGuidePromptProductionIdPageBuilder',
      'ProdProcessGuideStartProductionOrderStep',
    ],
    relatedTopics: ['warehouse-mobile-app', 'process-guide-framework', 'barcode-scanning'],
  },

  // ── ProcessGuide: add a control to an existing screen ─────────────────────
  {
    id: 'processguide-page-control',
    displayName: 'Add a control to an existing screen',
    aliases: ['add-control', 'extend-page', 'add-field-to-screen'],
    framework: 'process-guide',
    purpose:
      'Show one more value (or ask for one more) on a screen that Microsoft already ships, without ' +
      'taking ownership of the whole screen.',
    whenToUse: [
      'The standard screen is right except for a missing field or label',
      'You want to keep receiving Microsoft changes to that screen',
    ],
    whenNotToUse: [
      'The layout has to change fundamentally — replace the page builder instead (processguide-page-replace)',
      'The extra value only needs to be VISIBLE, not computed: promoted fields and app field names are configuration and need no code at all',
    ],
    objects: [
      {
        role: 'Page-builder extension',
        naming: '{Area}{StandardPageBuilder}_Extension',
        baseOrType: 'class, [ExtensionOf(classStr(<standard page builder>))]',
        notes: 'Chain of Command wrapper around addDataControls(). Confirm the exact page-builder class for the step with find_references before writing the ExtensionOf.',
      },
    ],
    skeletons: [
      {
        label: 'CoC on addDataControls — one more label on a standard screen',
        code: `/// <summary>
/// Adds the customer reference to the standard confirm screen, so the worker
/// can see which customer the pick belongs to.
/// </summary>
[ExtensionOf(classStr(MyStandardProcessGuideConfirmPageBuilder))]
final class MyDemoConfirmPageBuilder_Extension
{
    protected void addDataControls(ProcessGuidePage _page)
    {
        next _page;

        // Append after the standard controls. Reading state from the
        // pass-through keeps the wrapper independent of the base's members.
        WhsrfPassthrough pass = controller.parmSessionState().parmPass();
        MyDemoCustomerRef reference = MyDemoPackService::customerRefOf(pass.lookup(ProcessGuideDataTypeNames::ContainerId));

        if (reference)
        {
            _page.addLabel(ProcessGuideDataTypeNames::MyDemoCustomerRef, reference, extendedTypeNum(MyDemoCustomerRef));
        }
    }
}`,
      },
    ],
    methodNotes: [
      'Wrap addDataControls() and call next FIRST when the control belongs after the standard ones — the order of the calls is the order on the screen.',
      'A control the worker must FILL IN also needs the step to accept it: check isComplete() on the step, or the flow moves on before your field is entered.',
      'Read state from the pass-through, not from base-class members: CoC gives you the augmented class, not its privates.',
      'A new data-type name and EDT are part of the change — a control with no EDT has no validation or lookup on the device.',
      CONFIRM_FIRST,
    ],
    crossChecks: [
      'get_knowledge(topic="coc-authoring") — a CoC wrapper must repeat the base signature exactly and must not copy default parameter values (COC001).',
      ...BUILD_CHECKS,
    ],
    relatedTopics: ['coc-authoring', 'warehouse-mobile-app'],
  },

  // ── ProcessGuide: replace a screen ────────────────────────────────────────
  {
    id: 'processguide-page-replace',
    displayName: 'Replace the UI of an existing step',
    aliases: ['replace-page', 'overhaul-screen', 'custom-page-builder'],
    framework: 'process-guide',
    purpose: 'Take over one screen of a standard flow completely, leaving the rest of the flow alone.',
    whenToUse: [
      'The standard layout is wrong for the process, not merely incomplete',
      'You need different controls, different order, or a different set of buttons',
    ],
    whenNotToUse: ['You only add a control — that is processguide-page-control, and it survives upgrades better'],
    objects: [
      {
        role: 'Replacement page builder',
        naming: '{Area}ProcessGuide{What}PageBuilder',
        baseOrType: 'class extends ProcessGuidePageBuilder, [ProcessGuidePageBuilderName(...)]',
      },
      {
        role: 'Step extension',
        naming: '{Area}{StandardStep}_Extension',
        baseOrType: 'class, [ExtensionOf(classStr(<standard step>))]',
        notes: 'Wraps pageBuilderName() to return the replacement.',
      },
    ],
    skeletons: [
      {
        label: 'Point an existing step at your own page builder',
        code: `/// <summary>
/// Replaces the standard confirm screen with a layout that leads on the
/// customer reference, which is what this warehouse sorts by.
/// </summary>
[ExtensionOf(classStr(MyStandardProcessGuideConfirmStep))]
final class MyDemoConfirmStep_Extension
{
    protected ProcessGuidePageBuilderName pageBuilderName()
    {
        // next is deliberately not called: the standard builder is replaced,
        // not extended. Returning a name no class carries fails at run time,
        // not at compile time - keep the classStr, never a string literal.
        return classStr(MyDemoProcessGuideConfirmPageBuilder);
    }
}`,
      },
    ],
    methodNotes: [
      'The replacement extends ProcessGuidePageBuilder and carries its own [ProcessGuidePageBuilderName] — the attribute is how the factory finds it.',
      'Not calling next in the wrapper is the point of this pattern; say so in a comment, because a silent missing next reads like a bug.',
      'Keep the standard data-type names for values the rest of the flow reads — the pass-through is a contract shared with the steps you did not replace.',
      'You inherit the base error behaviour (rebuild, clear, show error) for free; override rebuildFromRequestPage() only if your layout cannot be rebuilt that way.',
      CONFIRM_FIRST,
    ],
    crossChecks: [
      'Walk the whole flow after the change, not just your screen — the next step still expects the values the original screen collected.',
      ...BUILD_CHECKS,
    ],
    relatedTopics: ['coc-authoring', 'warehouse-mobile-app'],
  },

  // ── ProcessGuide: insert a screen into an existing flow ───────────────────
  {
    id: 'processguide-step-insert',
    displayName: 'Insert a screen into an existing flow',
    aliases: ['add-step', 'insert-step', 'extra-screen'],
    framework: 'process-guide',
    purpose: 'Add a screen (or a silent action) between two steps of a flow that already exists.',
    whenToUse: [
      'The process needs one more confirmation, capture or check in the middle of a standard flow',
      'A custom validation must happen before the standard flow commits',
    ],
    objects: [
      {
        role: 'New step (+ page builder when it has a screen)',
        naming: '{Area}ProcessGuide{What}Step',
        baseOrType: 'class extends ProcessGuideStep or ProcessGuideStepWithoutPrompt',
      },
      {
        role: 'Controller extension',
        naming: '{Area}{StandardController}_Extension',
        baseOrType: 'class, [ExtensionOf(classStr(<standard controller>))]',
        notes: 'Wraps initializeNavigationRoute() and re-points the two edges around the new step.',
      },
    ],
    skeletons: [
      {
        label: 'Re-route the flow through the new step',
        code: `/// <summary>
/// Routes the standard pack flow through an extra weight-capture screen
/// before the pack is registered.
/// </summary>
[ExtensionOf(classStr(MyStandardProcessGuidePackController))]
final class MyDemoPackController_Extension
{
    protected ProcessGuideNavigationRoute initializeNavigationRoute()
    {
        ProcessGuideNavigationRoute navigationRoute = next initializeNavigationRoute();

        // Inserting means re-pointing BOTH edges: the step before now leads to
        // the new screen, and the new screen leads where that step used to.
        // Adding only the first edge strands the flow on the new screen.
        navigationRoute.addFollowingStep(classStr(MyStandardProcessGuideConfirmStep), classStr(MyDemoProcessGuideCaptureWeightStep));
        navigationRoute.addFollowingStep(classStr(MyDemoProcessGuideCaptureWeightStep), classStr(MyStandardProcessGuideRegisterStep));

        return navigationRoute;
    }
}`,
      },
    ],
    methodNotes: [
      'Call next FIRST and then override the edges — building a fresh route in the wrapper discards every step Microsoft (and any other extension) put there.',
      'Re-point both edges. The commonest defect is adding "confirm → my step" and forgetting "my step → register", which strands the worker.',
      'A flow whose branching is not a plain map has its own navigation agent; extending the route then does nothing. Check whether the controller overrides navigationAgentFactory() before assuming.',
      'A silent step (ProcessGuideStepWithoutPrompt) is the right shape for a check or a post — it needs no page builder.',
      CONFIRM_FIRST,
    ],
    crossChecks: [
      'Run the flow end to end including Cancel: the controller resets to the initial step, and a half-inserted route shows up there first.',
      ...BUILD_CHECKS,
    ],
    relatedTopics: ['coc-authoring', 'warehouse-mobile-app'],
  },

  // ── The app's step identity ───────────────────────────────────────────────
  {
    id: 'app-step-identity',
    displayName: 'Step identity in the app (icon, title, instruction)',
    aliases: ['step-id', 'step-icon', 'step-title', 'stepinfo'],
    framework: 'app-metadata',
    purpose:
      'Give a screen its identity in the Warehouse Management mobile app: the step ID that keys it, ' +
      'the icon and title the worker sees, and the instruction text the business can rewrite.',
    whenToUse: [
      'A new screen whose primary input control name is not one of the standard step IDs',
      'A standard screen that must show a different icon or title in one flow',
    ],
    whenNotToUse: [
      'Only the WORDS change — titles and instructions per step (and per menu item) are configuration on the Mobile device steps page, in every language, with no code',
    ],
    objects: [
      {
        role: 'Step class',
        naming: 'WHSMobileAppStep{ControlName}',
        baseOrType: 'class extends WHSMobileAppStep, [WHSMobileAppStepId(\'{ControlName}\')]',
        notes: 'The step ID is the control name of the screen PRIMARY input field. initValues() sets defaultStepIcon and defaultStepTitle.',
      },
      {
        role: 'Step info builder (only to override per flow)',
        naming: 'WHSMobileAppStepInfoBuilder{Process}',
        baseOrType: 'class extends WHSMobileAppStepInfoBuilder, [WHSWorkExecuteMode(...)]',
        notes: 'Override stepId() to map one control to a different step, or stepInfo() to set icon/title directly.',
      },
    ],
    skeletons: [
      {
        label: 'Step class for a control the platform does not know',
        code: `/// <summary>
/// Gives the container-scanning screen its icon and title in the mobile app.
/// The step id matches the control name of the screen primary input field.
/// </summary>
[WHSMobileAppStepId('MyDemoContainerId')]
final internal class WHSMobileAppStepMyDemoContainerId extends WHSMobileAppStep
{
    private const WHSMobileAppStepIcon PopulationIcon = 'InventBatchID';
    private const WHSMobileAppStepTitle InputNotFilledTitle = "@WAX:MyDemoScanContainer";

    protected void initValues()
    {
        defaultStepIcon  = PopulationIcon;
        defaultStepTitle = InputNotFilledTitle;
    }
}`,
      },
    ],
    methodNotes: [
      'Step ID = the control name of the primary input field on the screen. Name the control first, then the step class after it; renaming the control later orphans the icon and title.',
      'Icons cannot be uploaded — pick one of the standard icon IDs the platform ships.',
      'Titles come in two flavours the app uses at different moments: one for input (empty field) and one for confirmation (pre-filled field).',
      'To reuse a standard step under a different look in ONE flow, override stepId() in that flow step-info builder and add a step class for the new id; to change only icon/title, override stepInfo() and set them on a WHSMobileAppStepInfo.',
      'These classes are the app presentation layer only — they do not create a screen. The screen comes from the page builder (process-guide) or the display class (legacy).',
      CONFIRM_FIRST,
    ],
    crossChecks: [
      'Load the default setup on Warehouse management > Setup > Mobile device > Mobile device steps, then check your step ID appears there before hunting for a code bug.',
      ...BUILD_CHECKS,
    ],
    referenceElements: ['WHSMobileAppStep', 'WHSMobileAppStepInfoBuilder', 'WHSMobileAppStepInfo'],
    relatedTopics: ['warehouse-mobile-app', 'labels'],
  },

  // ── The legacy framework ──────────────────────────────────────────────────
  {
    id: 'legacy-workexecutedisplay',
    displayName: 'Legacy screen (WHSWorkExecuteDisplay)',
    aliases: ['legacy', 'workexecutedisplay', 'displayform', 'old-framework'],
    framework: 'legacy',
    purpose:
      'Change a flow that is still built the original way: one WHSWorkExecuteDisplay subclass per ' +
      'WHSWorkExecuteMode whose displayForm() processes the input, runs the logic, increments the step ' +
      'and builds the next screen as a container.',
    whenToUse: [
      'The flow you must change has not been converted to ProcessGuide in the installed version',
      'A small, surgical change to an existing legacy screen where converting the flow is out of scope',
    ],
    whenNotToUse: [
      'You are building a NEW flow and the ProcessGuide classes exist — build it there instead; the legacy shape is what the redesign exists to get away from',
    ],
    objects: [
      {
        role: 'Display class (or its extension)',
        naming: 'WHSWorkExecuteDisplay{Process} / {Area}{Class}_Extension',
        baseOrType: 'class extends WHSWorkExecuteDisplay, or [ExtensionOf(...)] over one',
        notes: 'displayForm() is the whole screen lifecycle. Wrap the narrowest build/process method you can find rather than the whole displayForm().',
      },
      {
        role: 'Execute class',
        naming: 'WHSWorkExecute',
        baseOrType: 'existing framework class',
        notes: 'Work is executed here, not by writing WHSWorkTable/WHSWorkLine.',
      },
    ],
    methodNotes: [
      'The screen is a container of controls built in a build…() method; the input comes back through WHSRFControlData, and processes with special handling override processControl().',
      'Session state travels in WhsrfPassthrough — the same pass-through the ProcessGuide steps use, which is why a converted flow keeps working with legacy data.',
      'displayForm() carries several responsibilities at once and is shared across modes (processWorkLine() alone is reached from every work-execution process). Wrapping it wholesale is how an extension breaks unrelated flows — wrap the narrowest method, guard on the mode, and call next.',
      'Do not add a new flow here just because the neighbours are legacy: check for the ProcessGuide classes first, and record which framework the flow uses in the change itself.',
      CONFIRM_FIRST,
    ],
    crossChecks: [
      'find_references on the method you wrap — a legacy display method is typically reached from more modes than the one you are testing.',
      ...BUILD_CHECKS,
    ],
    referenceElements: ['WHSWorkExecuteDisplay', 'WHSWorkExecute', 'WHSRFControlData', 'WHSWorkExecuteMode'],
    relatedTopics: ['warehouse-mobile-app', 'coc-authoring'],
  },

  // ── GS1 scanning into a screen ────────────────────────────────────────────
  {
    id: 'gs1-scan-input',
    displayName: 'GS1 scanning into a screen (setup, not code)',
    aliases: ['gs1', 'barcode-input', 'scan-setup', 'multiple-field-scanning'],
    framework: 'configuration',
    purpose:
      'Make a screen accept a GS1 bar code — one scan filling one field, or one scan filling several — ' +
      'using the parser the platform already has.',
    whenToUse: [
      'A worker scans a GS1-128, GS1 DataMatrix or GS1 QR label into a mobile flow',
      'You want one scan to fill item, batch and expiry at once instead of three prompts',
    ],
    whenNotToUse: [
      'The scan happens OUTSIDE the warehouse app (a rich-client form, an integration) — there is no menu item to hang a policy on, so that path is code',
    ],
    objects: [
      {
        role: 'Global bar code options',
        naming: '(setup)',
        baseOrType: 'Warehouse management parameters > General > Bar codes',
        notes: 'FNC1 / DataMatrix / QR prefix characters, the printable stand-in for the ASCII 29 group separator, and the policy for an unknown application identifier (error vs skip).',
      },
      {
        role: 'Application identifier list',
        naming: '(setup)',
        baseOrType: 'GS1 application identifier setup',
        notes: 'Load the standard international list first, then extend. An identifier missing here is what the unknown-AI policy acts on.',
      },
      {
        role: 'Bar code data policy',
        naming: '(setup)',
        baseOrType: 'policy linked to mobile device menu items',
        notes: 'Multiple-field scanning: maps an application identifier onto a control (01 → the item control, 10 → the batch control). This is the only place that behaviour is decided.',
      },
    ],
    methodNotes: [
      'Do NOT write an X++ GS1 parser for a warehouse-app flow. The platform parses the scan before it reaches the flow and pushes the elements into the controls; a hand-rolled parser duplicates it and diverges on the next standard change.',
      'The scanner hardware is part of the configuration: it must add a recognised prefix (the AIM identifiers ]C1, ]e0, ]d2, ]Q3, ]J1 map to the GS1 symbologies) and convert the non-printable group separator to the printable character named in the parameters.',
      'Single-field scanning fills only the focused control and needs the generic setup alone; multiple-field scanning pushes several values into flow state and needs a policy on the menu item.',
      'Multiple-field scanning changes WHEN a flow has values, so a step can be skipped that a custom extension assumed would run. Test a custom flow with the policy on and off.',
      'Only the code path that is genuinely outside the app parses by hand — application identifier by application identifier, ending a variable-length element at the group separator, never at a fixed offset.',
    ],
    crossChecks: [
      'Scan a real label, not a printout of the human-readable text: the FNC1 prefix and the group separator are exactly what a re-typed value loses.',
      'Check the unknown-application-identifier policy before blaming the flow — "Error" refuses the whole scan for one unmapped element.',
    ],
    relatedTopics: ['barcode-scanning', 'warehouse-mobile-app'],
  },
];
