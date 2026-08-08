/**
 * Shared builders for AxService / AxServiceGroup XML.
 *
 * Element shapes verified against the real AOT on the dev VM
 * (`ApplicationSuite/Foundation/AxService/*.xml`, `.../AxServiceGroup/*.xml`):
 *
 *   AxService        → Name, [Class], [Description], [ExternalName], [Namespace],
 *                      ServiceOperations/AxServiceOperation
 *   AxServiceOperation → Name, [EnableIdempotence], [Method], [SubscriberAccessLevel/Read]
 *   AxServiceGroup   → Name, [AutoDeploy], [Description], Services/AxServiceGroupService
 *   AxServiceGroupService → Name, Service
 *
 * Child elements are ordered Name-first then alphabetically, which is what every
 * shipped file does — the deserializer is order-sensitive for DataContract members.
 *
 * The operation's <Method> is the X++ method on the service class; <Name> is the
 * externally visible operation name. All 40 shipped AxService files carry
 * <Class>, <ExternalName> and <ServiceOperations>, so those are always emitted
 * (defaulting to the service name) rather than left out.
 */
import { escapeXml } from '../utils/xmlEscape.js';


interface ServiceOperationDef {
  /** Externally visible operation name. Defaults to `method`. */
  name?: string;
  /** X++ method on the service class. Defaults to `name`. */
  method?: string;
  /** Yes when the operation is safe to repeat (GET-like). */
  enableIdempotence?: boolean | string;
  /** Read access for external subscribers, e.g. "Allow". */
  subscriberAccessLevelRead?: string;
}

interface ServiceGroupServiceDef {
  /** Entry name inside the group. Defaults to `service`. */
  name?: string;
  /** The AxService this entry points at. Defaults to `name`. */
  service?: string;
}

function yesNo(value: boolean | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  return value ? 'Yes' : 'No';
}

/** Accepts ["opA", "opB"] shorthand as well as the full object form. */
function normalizeOperations(raw: unknown): ServiceOperationDef[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(op => (typeof op === 'string' ? { name: op } : (op as ServiceOperationDef)));
}

/** Accepts ["MyService"] shorthand as well as the full object form. */
function normalizeGroupServices(raw: unknown): ServiceGroupServiceDef[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(s => (typeof s === 'string' ? { service: s } : (s as ServiceGroupServiceDef)));
}

/**
 * properties.serviceClass / properties.class  — X++ class holding the operation
 *                                               methods. Defaults to the service name.
 * properties.externalName                     — defaults to the service name.
 * properties.namespace                        — SOAP namespace (rarely needed).
 * properties.description                      — label id or free text.
 * properties.operations                       — ["lookup"] or
 *                                               [{ name?, method?, enableIdempotence?,
 *                                                  subscriberAccessLevelRead? }]
 */
export function buildAxServiceXml(serviceName: string, properties?: Record<string, any>): string {
  const serviceClass: string = properties?.serviceClass || properties?.class || serviceName;
  const externalName: string = properties?.externalName || serviceName;
  const namespace: string | undefined = properties?.namespace;
  const description: string | undefined = properties?.description;
  const operations = normalizeOperations(properties?.operations);

  const operationsXml = operations.length
    ? operations.map(op => {
      const opName = op.name || op.method || '';
      const method = op.method || op.name || '';
      const inner: string[] = [`\t\t\t<Name>${opName}</Name>`];
      const idempotence = yesNo(op.enableIdempotence);
      if (idempotence) inner.push(`\t\t\t<EnableIdempotence>${idempotence}</EnableIdempotence>`);
      inner.push(`\t\t\t<Method>${method}</Method>`);
      if (op.subscriberAccessLevelRead) {
        inner.push(
          `\t\t\t<SubscriberAccessLevel>\n\t\t\t\t<Read>${op.subscriberAccessLevelRead}</Read>\n\t\t\t</SubscriberAccessLevel>`,
        );
      }
      return `\t\t<AxServiceOperation>\n${inner.join('\n')}\n\t\t</AxServiceOperation>`;
    }).join('\n')
    : '';

  const operationsBlock = operations.length
    ? `\t<ServiceOperations>\n${operationsXml}\n\t</ServiceOperations>`
    : `\t<ServiceOperations />`;

  return `<?xml version="1.0" encoding="utf-8"?>
<AxService xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${serviceName}</Name>
\t<Class>${serviceClass}</Class>${description ? `\n\t<Description>${escapeXml(description)}</Description>` : ''}
\t<ExternalName>${externalName}</ExternalName>${namespace ? `\n\t<Namespace>${namespace}</Namespace>` : ''}
${operationsBlock}
</AxService>
`;
}

/**
 * properties.autoDeploy   — Yes publishes the group at /api/services without a
 *                           manual deployment step.
 * properties.description  — label id or free text.
 * properties.services     — ["MyService"] or [{ name?, service? }]
 */
export function buildAxServiceGroupXml(groupName: string, properties?: Record<string, any>): string {
  const autoDeploy = yesNo(properties?.autoDeploy);
  const description: string | undefined = properties?.description;
  const services = normalizeGroupServices(properties?.services);

  const servicesXml = services.length
    ? services.map(s => {
      const entryName = s.name || s.service || '';
      const target = s.service || s.name || '';
      return `\t\t<AxServiceGroupService>\n\t\t\t<Name>${entryName}</Name>\n\t\t\t<Service>${target}</Service>\n\t\t</AxServiceGroupService>`;
    }).join('\n')
    : '';

  const servicesBlock = services.length
    ? `\t<Services>\n${servicesXml}\n\t</Services>`
    : `\t<Services />`;

  return `<?xml version="1.0" encoding="utf-8"?>
<AxServiceGroup xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${groupName}</Name>${autoDeploy ? `\n\t<AutoDeploy>${autoDeploy}</AutoDeploy>` : ''}${description ? `\n\t<Description>${escapeXml(description)}</Description>` : ''}
${servicesBlock}
</AxServiceGroup>
`;
}
