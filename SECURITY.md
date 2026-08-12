# Security Policy

## Supported versions

Security fixes are released for the latest minor version on npm (`d365fo-mcp`). Older versions are not backported.

| Version | Supported |
|---------|-----------|
| 1.10.x  | ✅ |
| < 1.10  | ❌ |

## Reporting a vulnerability

**Please do not open a public issue.**

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/dynamics365ninja/d365fo-mcp-server/security/advisories/new)** (Security → Advisories → Report a vulnerability)

This opens a private thread visible only to maintainers, and lets us credit you in the published advisory.

Helpful to include:

- Affected version, and whether you are running stdio, local HTTP, or Azure App Service
- The file and line, or a request that demonstrates the behaviour
- What an attacker gains — reading indexed source, writing to `PackagesLocalDirectory`, executing on the build VM

### What to expect

| Stage | Target |
|-------|--------|
| Acknowledgement | 3 working days |
| Initial assessment | 10 working days |
| Fix released | 90 days, sooner for actively exploitable issues |

We request a CVE from the GitHub CNA for anything we assess as valid, and publish the advisory once the fix ships. You will be credited under the name or handle you choose unless you ask otherwise.

## Threat model

Some context on what this project treats as a vulnerability, so reports land accurately.

**The index is sensitive.** The symbol database is built from your `PackagesLocalDirectory`. It contains X++ source snippets, extension and event-handler wiring, security roles, privileges and duties, and label text — including your own custom models, not just the standard Microsoft ones. Treat any unauthenticated read path into it as a disclosure of proprietary source.

**In scope**

- Reaching MCP tools on an HTTP deployment without valid authentication
- Reading indexed metadata across a boundary that should have separated it
- Write tools escaping their intended path — writing outside the configured metadata root, or executing arbitrary commands on the build VM
- Insecure defaults in `infrastructure/` that produce an exposed deployment by following the documented steps
- Credential leakage into logs, tool output, or error responses

**Out of scope**

- `MCP_SERVER_MODE` — a tool-surface partition for the hybrid deployment, not a privilege boundary. It limits which tools are reachable, not who may reach them.
- Findings that require an attacker who already has the API key, filesystem access to the VM, or Azure control-plane rights
- A deployment where the operator has deliberately set `ALLOW_UNAUTHENTICATED=true`
- Vulnerabilities in D365 F&O, Visual Studio, or the Microsoft-supplied metadata assemblies themselves

## Hardening an Azure deployment

The one-click template requires an `API_KEY` and pins the App Service to `read-only`. Beyond that, and outside the template's scope:

- Put a **Private Endpoint** or IP restrictions in front of the App Service if the team's addresses are known
- Layer **Easy Auth / Entra ID** for per-user identity rather than one shared key
- Rotate `API_KEY` when someone leaves the project — it is a single shared secret
- Keep the storage account's `allowBlobPublicAccess` at `false` (the template sets this)
