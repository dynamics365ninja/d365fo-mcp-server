/**
 * Op-spec lookup tests.
 *
 * Issue #825 took the per-operation parameter contracts out of the d365fo_file
 * and generate_object wire schemas. The trade only pays if the contract is
 * genuinely reachable, so these tests pin the two halves of that promise:
 * every discriminator the schemas still advertise resolves to a real spec, and
 * every spec names the lookup that returns it.
 */

import { describe, it, expect } from 'vitest';
import { lookupOpSpec, renderOpSpecIndex, opSpecTopics } from '../../src/tools/opSpecs';
import { getKnowledgeTool } from '../../src/tools/getKnowledge';
import { d365foFileTool } from '../../src/server/toolSchemas/d365foFile';
import { generateObjectTool as generateObjectSchema } from '../../src/server/toolSchemas/generateObject';
import { D365FO_FILE_OP_SPECS } from '../../src/tools/d365foFileOpSpecs';
import { GENERATE_OBJECT_MODE_SPECS } from '../../src/tools/generateObjectOpSpecs';

function callKnowledge(args: Record<string, unknown>) {
  return getKnowledgeTool({ method: 'tools/call', params: { name: 'get_knowledge', arguments: args } } as any);
}

describe('lookupOpSpec', () => {
  it('resolves every d365fo_file modify operation the schema advertises', () => {
    const enumValues: string[] = (d365foFileTool.inputSchema.properties as any).operation.enum;
    for (const operation of enumValues) {
      const spec = lookupOpSpec(operation);
      expect(spec, `no spec for operation '${operation}'`).not.toMatch(/^Unknown operation/);
      expect(spec, `spec for '${operation}' must name the lookup`).toContain('kind="op-spec"');
    }
    // The enum and the registry are the same set — neither may drift.
    expect([...enumValues].sort()).toEqual(Object.keys(D365FO_FILE_OP_SPECS).sort());
  });

  it('resolves every generate_object mode the schema advertises', () => {
    const modes: string[] = (generateObjectSchema.inputSchema.properties as any).mode.enum;
    for (const mode of modes) {
      const spec = lookupOpSpec(mode);
      expect(spec, `no spec for mode '${mode}'`).not.toMatch(/^Unknown generate_object mode/);
      expect(spec).toContain('kind="op-spec"');
    }
    expect(Object.keys(GENERATE_OBJECT_MODE_SPECS)).toEqual(expect.arrayContaining(modes));
  });

  it('resolves the scaffold sub-specs by objectType', () => {
    for (const objectType of ['table', 'form', 'report']) {
      const spec = lookupOpSpec(`scaffold:${objectType}`);
      expect(spec).toContain(`generate_object(mode="scaffold")`);
      expect(spec).toContain('REQUIRED name');
    }
    expect(lookupOpSpec('scaffold:form')).toContain('cloneFrom');
    expect(lookupOpSpec('scaffold:report')).toContain('contractParams');
  });

  it('returns the create `properties` contract for an objectType', () => {
    const spec = lookupOpSpec('data-entity');
    expect(spec).toContain('action="create"');
    expect(spec).toContain('primaryTable');
  });

  it('answers an objectType that takes no extra properties without pretending otherwise', () => {
    const spec = lookupOpSpec('tile');
    expect(spec).toContain('no extra `properties`');
    expect(spec).toContain('table');
  });

  it('is case-insensitive and strips a tool-qualified prefix', () => {
    expect(lookupOpSpec('ADD-INDEX')).toContain("operation 'add-index'");
    expect(lookupOpSpec('d365fo_file.add-index')).toContain("operation 'add-index'");
    expect(lookupOpSpec('generate_object:pattern')).toContain('mode="pattern"');
  });

  it('falls back to the index for an unknown or empty topic', () => {
    expect(lookupOpSpec()).toBe(renderOpSpecIndex());
    expect(lookupOpSpec('   ')).toBe(renderOpSpecIndex());
    const unknown = lookupOpSpec('add-widget');
    expect(unknown).toContain("No op-spec for topic 'add-widget'");
    expect(unknown).toContain('add-index');
  });

  it('documents the resolution overrides that left the wire schema', () => {
    // packageName/packagePath/solutionPath/workspacePath are still accepted
    // (nested in `params`) but no longer advertised — the index is where the
    // agent learns they exist at all.
    const index = renderOpSpecIndex();
    for (const param of ['packageName', 'packagePath', 'solutionPath', 'workspacePath']) {
      expect(index, `${param} is not documented anywhere`).toContain(param);
    }
  });

  it('lists all three topic spaces in the index', () => {
    const topics = opSpecTopics();
    expect(topics.modifyOperations.length).toBeGreaterThan(20);
    expect(topics.createObjectTypes.length).toBeGreaterThan(15);
    expect(topics.generateModes.length).toBeGreaterThan(5);
  });
});

describe('get_knowledge(kind="op-spec")', () => {
  it('returns the spec for a topic', async () => {
    const res: any = await callKnowledge({ kind: 'op-spec', topic: 'add-relation' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('relationConstraints');
  });

  it('accepts the parameter names a model reaches for instead of `topic`', async () => {
    for (const args of [
      { kind: 'op-spec', operation: 'add-index' },
      { kind: 'op-spec', objectType: 'add-index' },
      { kind: 'op-spec', mode: 'add-index' },
    ]) {
      const res: any = await callKnowledge(args);
      expect(res.content[0].text, JSON.stringify(args)).toContain("operation 'add-index'");
    }
  });

  it('returns the index when no topic is given', async () => {
    const res: any = await callKnowledge({ kind: 'op-spec' });
    expect(res.content[0].text).toContain('Op-spec lookup');
  });

  it('does not hijack a plain knowledge lookup', async () => {
    const res: any = await callKnowledge({ topic: 'table' });
    expect(res.content[0].text).not.toContain('Op-spec lookup');
  });
});
