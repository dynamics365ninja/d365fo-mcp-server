# Working on this repository

These instructions are for contributing to this repository. Instructions for end users of the MCP
server in their X++ workspaces live in `.github/copilot-instructions.md` (which users copy to their
own workspace as `CLAUDE.md`, see docs/SETUP.md) and in the `xpp_system_instructions` prompt
(src/prompts/systemInstructions.ts). Edit those, not this file, to change agent behaviour in users'
workspaces.

## No real customer or project names

Tests, fixtures, examples, comments, docs, commit messages, branch names and PR titles and
descriptions must not contain names taken from real D365FO environments: models, packages, label
file IDs, object names, prefixes, paths or company names. This applies even when you used such an
environment to check how Visual Studio or D365FO really behaves (e.g. copying the exact bytes of a
file it wrote).

Treat every name you read on this machine as real unless it belongs to a Microsoft standard model.
That covers PackagesLocalDirectory, the user's solutions, `.rnrproj` and `.mcp.json` files, the
d365fo MCP index, label files and the AOS database. Microsoft standard objects (`CustTable`,
`SalesLine`, `SYS` labels, …) and demo data (`USMF`, `DEMF`) are fine.

Use the generic names the repo already uses: `ContosoExt` / `ContosoCore` for models and packages,
`ContosoExt` (or `MyModel`) for label file IDs, and a `Contoso` prefix for objects
(`ContosoRentEquipmentTable`).

Before finishing a change, run `git diff` and look at every name that isn't Microsoft's. If you
can't tell whether it is real, rename it to a `Contoso…` name or ask.

## CHANGELOG entry with every change

Every change that a user, or an agent using the server, can notice gets an entry in
[CHANGELOG.md](CHANGELOG.md) in the same commit or PR as the change itself — not later, and not left
for the release PR.

- **Needs an entry:** tool results, schemas and descriptions; the system prompt and knowledge
  files; configuration and env vars; the C# bridge; install and deploy scripts; dependency bumps;
  docs that users act on.
- **Exempt:** refactors with no observable effect, test-only, CI-only, eval-corpus-only and
  contributor-only changes (like this file). If unsure, write the entry.

Where and how:

- Put it under `## [Unreleased]`, in the matching subsection: `### Added`, `### Changed`,
  `### Fixed`, `### Removed`, `### Security` or `### Dependencies` (create it if missing). Never
  write under a released version heading, bump `package.json` or add version headings; the release
  PR does that.
- A change that renames, retires or unpublishes a tool or parameter is breaking for anyone's
  prompts: also add a bullet under `### Breaking` saying what callers must change (see *Versioning*
  in CHANGELOG.md).
- Follow the existing style: one bullet per change, starting with a **bold one-sentence summary**
  written from the user's point of view, then the cause, the old and new behaviour, and anything
  the user must do (re-index, change config), concretely. Add the issue number in parentheses when
  there is one. Hard-wrap lines at about 90 columns and indent continuation lines by two spaces.
- Write the entry before you report the change as done, and update it if the scope of the change
  shifts during review.
