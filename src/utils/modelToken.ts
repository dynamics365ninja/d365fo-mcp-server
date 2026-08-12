/**
 * The spelling of a model name that may appear INSIDE an AOT object name.
 *
 * A model name is free text — "Contoso Robotics" is an ordinary thing for Visual
 * Studio to create — but an AOT element name is an identifier and cannot carry a
 * space. Embedding the raw name (EXTENSION_NAMING_STYLE=model-name) therefore
 * produced `CustTable.Contoso Robotics`, which no build accepts (issue #892).
 *
 * Stripping everything outside [A-Za-z0-9_] is not a guess at what the platform
 * does — it IS what the platform does. The descriptor of the one shipped model
 * whose name has a space states:
 *   <Name>Monitoring and Telemetry</Name> → <ModelModule>MonitoringandTelemetry</ModelModule>
 * i.e. the name with whitespace removed, character for character, lowercase "and"
 * intact. Visual Studio names extensions in that model-derived spelling too, so
 * the token computed here matches the extensions a model already contains.
 *
 * Deriving the token from <ModelModule> instead was considered and rejected:
 * ModelModule is per-PACKAGE, not per-model (all five models in ApplicationSuite
 * report ModelModule=ApplicationSuite), so every model sharing a package would
 * collapse onto one token.
 *
 * Returns the name unchanged for any model whose name is already an identifier,
 * which is every model that does not contain a space.
 *
 * Lives in its own module rather than in modelClassifier because the naming
 * surface of that module is mocked wholesale by a dozen write-path test files;
 * a helper added there is a helper every one of those mocks has to re-declare.
 */
export function normalizeModelToken(modelName: string): string {
  return modelName.replace(/[^A-Za-z0-9_]/g, '');
}
