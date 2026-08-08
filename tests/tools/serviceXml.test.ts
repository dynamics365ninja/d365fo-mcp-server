/**
 * buildAxServiceXml / buildAxServiceGroupXml (src/tools/serviceXml.ts).
 *
 * Gap: eval case L3-custom-service-basic was blocked because d365fo_file's
 * objectType enum had no `service` / `service-group`, so a custom service could
 * not be created through the grounded tool path at all (findings from the
 * Contoso golden-capture run 2026-07-20).
 *
 * Element shapes here are pinned to the real AOT on the dev VM
 * (ApplicationSuite/Foundation/AxService/DimensionService.xml and
 * .../AxServiceGroup/FinancialDimensionServices.xml) — notably
 * <ServiceOperations>/<AxServiceOperation>, NOT the flat <Operations> list the
 * knowledge base used to claim.
 */

import { describe, it, expect } from 'vitest';
import { buildAxServiceXml, buildAxServiceGroupXml } from '../../src/tools/xml/serviceXml';

describe('buildAxServiceXml', () => {
  it('emits the AOT element shape: Name, Class, ExternalName, ServiceOperations', () => {
    const xml = buildAxServiceXml('DemoNoteService', {
      serviceClass: 'DemoNoteLookupService',
      operations: ['lookup'],
    });
    expect(xml).toContain('<AxService xmlns:i="http://www.w3.org/2001/XMLSchema-instance">');
    expect(xml).toContain('<Name>DemoNoteService</Name>');
    expect(xml).toContain('<Class>DemoNoteLookupService</Class>');
    expect(xml).toContain('<ExternalName>DemoNoteService</ExternalName>');
    expect(xml).toContain('<AxServiceOperation>');
    expect(xml).toContain('<Method>lookup</Method>');
    // The flat <Operations> shape does not exist in any shipped AxService.
    expect(xml).not.toContain('<Operations>');
  });

  it('defaults Class and ExternalName to the service name', () => {
    const xml = buildAxServiceXml('DemoNoteService');
    expect(xml).toContain('<Class>DemoNoteService</Class>');
    expect(xml).toContain('<ExternalName>DemoNoteService</ExternalName>');
  });

  it('accepts `class` as an alias for serviceClass', () => {
    const xml = buildAxServiceXml('DemoNoteService', { class: 'DemoNoteLookupService' });
    expect(xml).toContain('<Class>DemoNoteLookupService</Class>');
  });

  it('keeps operation Name and Method distinct when both are given', () => {
    const xml = buildAxServiceXml('DemoNoteService', {
      operations: [{ name: 'LookupNote', method: 'lookup' }],
    });
    expect(xml).toContain('<Name>LookupNote</Name>');
    expect(xml).toContain('<Method>lookup</Method>');
  });

  it('writes EnableIdempotence and SubscriberAccessLevel/Read when asked', () => {
    const xml = buildAxServiceXml('DemoNoteService', {
      operations: [{ name: 'lookup', enableIdempotence: true, subscriberAccessLevelRead: 'Allow' }],
    });
    expect(xml).toContain('<EnableIdempotence>Yes</EnableIdempotence>');
    expect(xml).toContain('<Read>Allow</Read>');
  });

  it('orders operation children Name, EnableIdempotence, Method (deserializer is order-sensitive)', () => {
    const xml = buildAxServiceXml('DemoNoteService', {
      operations: [{ name: 'lookup', enableIdempotence: true }],
    });
    const name = xml.indexOf('<Name>lookup</Name>');
    const idem = xml.indexOf('<EnableIdempotence>');
    const method = xml.indexOf('<Method>');
    expect(name).toBeLessThan(idem);
    expect(idem).toBeLessThan(method);
  });

  it('emits optional Description/Namespace only when supplied', () => {
    const bare = buildAxServiceXml('DemoNoteService', { operations: ['lookup'] });
    expect(bare).not.toContain('<Description>');
    expect(bare).not.toContain('<Namespace>');

    const full = buildAxServiceXml('DemoNoteService', {
      description: '@SYS123',
      namespace: 'http://schemas.contoso.com/demo',
      operations: ['lookup'],
    });
    expect(full).toContain('<Description>@SYS123</Description>');
    expect(full).toContain('<Namespace>http://schemas.contoso.com/demo</Namespace>');
    // Name first, then alphabetical: Class, Description, ExternalName, Namespace.
    expect(full.indexOf('<Description>')).toBeLessThan(full.indexOf('<ExternalName>'));
    expect(full.indexOf('<ExternalName>')).toBeLessThan(full.indexOf('<Namespace>'));
  });

  it('emits a self-closing ServiceOperations when no operations are given', () => {
    expect(buildAxServiceXml('DemoNoteService')).toContain('<ServiceOperations />');
  });
});

describe('buildAxServiceGroupXml', () => {
  it('emits the AOT element shape with one AxServiceGroupService per member', () => {
    const xml = buildAxServiceGroupXml('DemoNoteServiceGroup', { services: ['DemoNoteService'] });
    expect(xml).toContain('<AxServiceGroup xmlns:i="http://www.w3.org/2001/XMLSchema-instance">');
    expect(xml).toContain('<Name>DemoNoteServiceGroup</Name>');
    expect(xml).toContain('<AxServiceGroupService>\n\t\t\t<Name>DemoNoteService</Name>\n\t\t\t<Service>DemoNoteService</Service>');
  });

  it('honours the object form with a distinct entry name', () => {
    const xml = buildAxServiceGroupXml('DemoNoteServiceGroup', {
      services: [{ name: 'Notes', service: 'DemoNoteService' }],
    });
    expect(xml).toContain('<Name>Notes</Name>');
    expect(xml).toContain('<Service>DemoNoteService</Service>');
  });

  it('writes AutoDeploy from a boolean and places it before Services', () => {
    const xml = buildAxServiceGroupXml('DemoNoteServiceGroup', {
      autoDeploy: true,
      services: ['DemoNoteService'],
    });
    expect(xml).toContain('<AutoDeploy>Yes</AutoDeploy>');
    expect(xml.indexOf('<AutoDeploy>')).toBeLessThan(xml.indexOf('<Services>'));
  });

  it('omits AutoDeploy/Description when not supplied', () => {
    const xml = buildAxServiceGroupXml('DemoNoteServiceGroup', { services: ['DemoNoteService'] });
    expect(xml).not.toContain('<AutoDeploy>');
    expect(xml).not.toContain('<Description>');
  });

  it('emits a self-closing Services when the group is empty', () => {
    expect(buildAxServiceGroupXml('DemoNoteServiceGroup')).toContain('<Services />');
  });
});

/**
 * Caller-wiring hazard, same class as
 * `L4-bridge-drops-data-entity-primarytable-fields-on-create` in eval/cases/.
 *
 * `d365fo_file(create)` prefixes only `objectName` (DemoNoteService →
 * ContosoDemoNoteService). Cross-references inside `properties` are written
 * verbatim, so a caller that passes the BASE name gets a group pointing at a
 * service that does not exist — it deploys and resolves to nothing.
 *
 * Verbatim is the deliberate choice (a group may reference a Microsoft service
 * such as DimensionService, which must never be prefixed), so these tests pin
 * the behaviour rather than "fix" it; the d365fo_file properties schema carries
 * the matching warning.
 */
describe('service cross-references are written verbatim (never auto-prefixed)', () => {
  it('does not prefix serviceClass to match a prefixed service name', () => {
    const xml = buildAxServiceXml('ContosoDemoNoteService', { serviceClass: 'DemoNoteLookupService' });
    expect(xml).toContain('<Name>ContosoDemoNoteService</Name>');
    expect(xml).toContain('<Class>DemoNoteLookupService</Class>');
  });

  it('does not prefix services[].service inside a group', () => {
    const xml = buildAxServiceGroupXml('ContosoDemoNoteServiceGroup', { services: ['DemoNoteService'] });
    expect(xml).toContain('<Service>DemoNoteService</Service>');
    expect(xml).not.toContain('<Service>ContosoDemoNoteService</Service>');
  });

  it('passes a Microsoft service reference through untouched — why verbatim is correct', () => {
    const xml = buildAxServiceGroupXml('ContosoFinancialServices', { services: ['DimensionService'] });
    expect(xml).toContain('<Service>DimensionService</Service>');
  });
});
