/**
 * Dispatch glue for move-control and wrap-controls (AxForm). Lives here because
 * modifyD365File.ts is held to a line budget (tests/utils/layering.test.ts): the
 * dispatcher spends one switch line on both operations. The edits are in
 * tools/xml/formRestructure.ts, the file write in directXmlWriters.ts.
 */

import { z } from 'zod';
import { directXmlRestructureForm, viaXmlFallback } from './directXmlWriters.js';
import { moveFormControl, wrapFormControls } from '../xml/formRestructure.js';

type Args = Record<string, any>;
type OpResult = { success: boolean; message: string; viaXmlFallback?: boolean; skipped?: boolean } | null;

const names = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : [];

/** One entry point for both operations; null (→ the op-spec error) when a required parameter is missing. */
export async function formStructureOp(operation: string, objectType: string, filePath: string, args: Args): Promise<OpResult> {
  if (objectType !== 'form') {
    return {
      success: false,
      message: `❌ ${operation} works on objectType="form" (a form of your own model). In a form extension the ` +
        `parent of a base control belongs to the base form; add-control places the controls an extension adds.`,
    };
  }
  if (operation === 'move-control') {
    if (!args.controlName) return null;
    return viaXmlFallback(await directXmlRestructureForm(filePath, xml => moveFormControl(xml, {
      controlName: args.controlName,
      parentControl: args.parentControl,
      previousSibling: args.previousSibling,
      positionType: args.positionType,
    })));
  }
  const controlNames = names(args.controlNames);
  if (controlNames.length === 0 || !args.containerName) return null;
  return viaXmlFallback(await directXmlRestructureForm(filePath, xml => wrapFormControls(xml, {
    controlNames,
    containerName: args.containerName,
    containerType: args.containerType,
    pattern: args.containerPattern,
    patternVersion: args.containerPatternVersion,
    caption: args.containerCaption,
    style: args.containerStyle,
  })));
}

/** Zod members for the parameters these operations add (spread into the modify schema). */
export const FORM_STRUCTURE_ZOD_PARAMS = {
  controlNames: z.union([z.array(z.string()), z.string()]).optional().describe('wrap-controls: the controls to wrap (one parent).'),
  containerName: z.string().optional().describe('wrap-controls: name of the new container control.'),
  containerType: z.string().optional().describe('wrap-controls: Group (default), Tab or TabPage.'),
  containerPattern: z.string().optional().describe('wrap-controls: Pattern of the new container (e.g. FieldsFieldGroups).'),
  containerPatternVersion: z.string().optional().describe('wrap-controls: PatternVersion; default = newest the catalogue knows.'),
  containerCaption: z.string().optional().describe('wrap-controls: Caption label id of the new container.'),
  containerStyle: z.string().optional().describe('wrap-controls: Style of the new container (e.g. FastTabs on a Tab).'),
};
