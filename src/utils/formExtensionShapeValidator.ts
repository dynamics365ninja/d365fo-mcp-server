/**
 * Form-extension control-shape validator.
 *
 * Catches the malformed AxFormExtension control shapes that an AI tends to produce
 * when hand-writing `xmlContent` (the escape hatch when add-control can't be used).
 * These exact mistakes were observed in the wild and silently produced a file that
 * the D365FO deserializer rejects — costing a long debugging + filesystem-grep
 * expedition. Flagging them at write time, with the correct shape, fixes that in one
 * shot.
 *
 * Correct shape (verified against shipped standard extensions, e.g.
 * InventItemSampling.AdvancedQualityManagement):
 *
 *   <AxFormExtensionControl xmlns="">
 *     <Name>FormExtensionControl{rand}</Name>
 *     <FormControl xmlns="" i:type="AxFormIntegerControl">
 *       <Name>Field</Name>
 *       <Type>Integer</Type>
 *       <FormControlExtension i:nil="true" />
 *       <DataField>Field</DataField>
 *       <DataSource>Table</DataSource>
 *       <Label>@Model:Label</Label>
 *     </FormControl>
 *     <Parent>ParentControl</Parent>
 *   </AxFormExtensionControl>
 */

export interface FormExtShapeProblem {
  found: string;
  expected: string;
  detail: string;
}

/**
 * The canonical correct shape, shown to the caller when a problem is found so they
 * can fix it without grepping standard packages.
 */
export const CORRECT_FORM_EXTENSION_CONTROL_TEMPLATE =
  `<AxFormExtensionControl xmlns="">\n` +
  `    <Name>FormExtensionControl{uniqueId}</Name>\n` +
  `    <FormControl xmlns="" i:type="AxFormIntegerControl">\n` +
  `        <Name>FieldName</Name>\n` +
  `        <Type>Integer</Type>\n` +
  `        <FormControlExtension i:nil="true" />\n` +
  `        <DataField>FieldName</DataField>\n` +
  `        <DataSource>TableName</DataSource>\n` +
  `        <Label>@Model:LabelId</Label>\n` +
  `    </FormControl>\n` +
  `    <Parent>ParentControlName</Parent>\n` +
  `</AxFormExtensionControl>`;

/**
 * Inspect form-extension XML for the known malformed control shapes. Returns an empty
 * array when the shape is fine. Pure + side-effect-free so it is trivially testable.
 */
export function validateFormExtensionControlShape(xml: string): FormExtShapeProblem[] {
  const problems: FormExtShapeProblem[] = [];

  // 1. Wrong wrapper element for a newly-added control.
  if (/<AxFormControlExtension\b/.test(xml)) {
    problems.push({
      found: '<AxFormControlExtension>',
      expected: '<AxFormExtensionControl xmlns="">',
      detail:
        'A new control added by a form extension is wrapped in <AxFormExtensionControl xmlns="">, ' +
        'not <AxFormControlExtension>.',
    });
  }

  // 2. Wrong parent-reference element.
  if (/<ParentControlName\b/.test(xml)) {
    problems.push({
      found: '<ParentControlName>',
      expected: '<Parent>',
      detail: 'The parent control is referenced with <Parent>Name</Parent>, not <ParentControlName>.',
    });
  }

  // 3. <FormControlExtension> used as the control CONTAINER (wrong) — i.e. an opening
  //    <FormControlExtension> that wraps an <AxForm…Control> child. The legitimate use
  //    is the self-closing <FormControlExtension i:nil="true" /> INSIDE a <FormControl>,
  //    which this pattern deliberately does not match.
  if (/<FormControlExtension\s*>[\s\S]*?<AxForm\w*Control\b/.test(xml)) {
    problems.push({
      found: '<FormControlExtension><AxForm…Control>',
      expected: '<FormControl xmlns="" i:type="AxForm…Control">',
      detail:
        'The control itself goes in <FormControl xmlns="" i:type="AxForm…Control">…</FormControl>. ' +
        '<FormControlExtension i:nil="true" /> is a separate, self-closing element INSIDE that FormControl.',
    });
  }

  // 4. Non-existent integer control element.
  if (/\bAxFormIntControl\b/.test(xml)) {
    problems.push({
      found: 'AxFormIntControl',
      expected: 'AxFormIntegerControl',
      detail:
        'The integer form control class is AxFormIntegerControl (with <Type>Integer</Type>). ' +
        'AxFormIntControl does not exist and fails deserialization.',
    });
  }

  return problems;
}

/**
 * Render a blocking error message for the detected problems, including the correct
 * template so the caller can fix the XML in a single edit (no package grepping).
 */
export function buildFormExtensionShapeError(
  objectName: string,
  problems: FormExtShapeProblem[],
): string {
  const rows = problems
    .map(p => `  • \`${p.found}\` → must be \`${p.expected}\`\n    ${p.detail}`)
    .join('\n');
  return (
    `⛔ form-extension "${objectName}" — the control XML uses a shape the D365FO deserializer rejects.\n\n` +
    `Problems found:\n${rows}\n\n` +
    `Correct shape for a bound control added to an existing parent:\n\`\`\`xml\n${CORRECT_FORM_EXTENSION_CONTROL_TEMPLATE}\n\`\`\`\n\n` +
    `Tip: prefer d365fo_file(action="modify", operation="add-control", objectType="form-extension", …) — ` +
    `it now emits this exact shape for you, so you rarely need to hand-write the XML.`
  );
}
