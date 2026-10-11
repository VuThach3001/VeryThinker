# Native client compatibility

VeryThinker installs project-local adapters. Generated files are checked by automated tests. Authenticated Codex App Server `0.162.1` observations confirm Sol and Luna selection and completed inference; [validation reports](validation.md) separately record engineering completion. Native skill-picker discovery and hook trust remain unverified. Finding an executable or a configuration file does not establish native behavior or model availability.

## Supported installation targets

| Target                      | Generated integration                                                                          | Verification status                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Codex local CLI/desktop/IDE | Instructions/skills/roles, project MCP/hooks, project-local App Server `0.162.1`               | Sol/Luna selection and inference observed on the pinned App Server; picker/hook discovery remains unverified     |
| Claude Code local           | `CLAUDE.md`, `.claude/skills`, `.claude/agents/*.md`, portable MCP and hooks                   | Resource generation remains available; strict Sol/Luna/Terra execution is restricted pending verified selection |
| GitHub Copilot in VS Code   | Repository instructions, `.github/skills`, `.github/agents/*.agent.md`, portable MCP and hooks | Resource generation remains available; strict exact-model execution is restricted pending verified selection    |
| Remote/cloud clients        | Local adapters may contain machine-specific absolute paths                                     | Restricted; install on the execution host and record a separate conformance run                                 |

`doctor` reports runtime support, generated file presence, executable availability, requested model mappings, and limitations. It leaves skill discovery, effective model selection, MCP invocation, and hook execution unverified until native evidence exists. Native executable versions are observed only when the executable can safely run with `--version`; Windows batch shims are reported without executing a shell.

## Format decisions and official references

- Codex agent definitions use TOML files in `.codex/agents` with role instructions and an optional requested model. Project MCP uses `.codex/config.toml`. Hook groups use `SessionStart`, `PostToolUse`, and `Stop`, with Windows command overrides. New or changed hooks require native trust review. [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), [hooks](https://learn.chatgpt.com/docs/hooks).
- Claude Code uses project agent Markdown frontmatter. A missing requested model uses `inherit`. Current documented hooks support executable `command` plus `args` directly, with no shell. The generated session-start handler was executed locally from a project path containing spaces; client discovery remains unverified. Older clients require a separate conformance check. [Subagents](https://code.claude.com/docs/en/sub-agents), [hook execution](https://code.claude.com/docs/en/hooks).
- Claude Code and current VS Code documentation both support portable root `.mcp.json` with `mcpServers`. VeryThinker generates a single shared server entry. Older VS Code clients can require an explicit `.vscode/mcp.json` conversion; such clients remain unverified. [Claude MCP](https://code.claude.com/docs/en/mcp), [VS Code MCP configuration](https://code.visualstudio.com/docs/agent-customization/mcp-servers).
- Copilot repository hooks use the version 1 lower camel case format. VS Code documents conversion of this format to its local hook format. Effective hook support depends on the selected client surface. [Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference), [VS Code hooks](https://code.visualstudio.com/docs/agent-customization/hooks).
- Copilot agents use `.agent.md` frontmatter. Model selection remains subject to client support and account availability. [Custom agents configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration).

References were checked on 2026-10-11. Compatibility is assessed by client surface and observed version, rather than the provider name alone.

## Model routing

Alpha.3 installed Codex projects use exact routing policy: Sol for manager/requirements/design/component contracts/verification strategy/review, Luna for bounded workers, and Terra only after native Luna-unavailability evidence. The project-local App Server acknowledges selection at thread start/resume; signed receipts retain selected model/provider/effort, native identities, configuration hashes, completion, permissions, and reroutes. Receipt validation and successful inference are separate conditions. A model catalog entry does not establish account access.

Historical alpha.2 records keep their requested/agent-reported observations and are never upgraded into native receipts. Directly initialized legacy fixtures remain useful for testing core record mechanics; generated adapters and an installed routing policy activate strict execution. Native schema fixtures include the pinned `0.153.4` response for regression and the `0.162.1` runtime conformance surface.

Hooks are advisory: disabling or rejecting them does not bypass CLI verification. MCP configuration alone does not grant trust or prove that a tool was invoked.

The authenticated Windows run encountered a host-specific sandbox refresh failure on a locked inherited Node REPL executable. Scoped VeryThinker MCP operations still generated files and ran checks. This establishes neither universal Windows failure nor generic native editing compatibility; the [runtime observations](validation/native-alpha3-windows-runtime.json) preserve the exact limitation.

## Installation and updates

The installer tracks managed files, marked instruction blocks, and individual JSON configuration entries with SHA-256 hashes and a package version. It preserves comments and sibling settings. Existing user-owned VeryThinker keys, malformed settings, edited files, and deleted managed content produce `.verythinker-update` candidates. Edited candidate files are also preserved by creating a numbered candidate. Review candidates explicitly; even `force` preserves user edits.

Alpha.2 migration applies the selected defaults only to unset model mappings. Authored overrides and conflicting routing/configuration receive reviewable candidates. Accepted historical evidence stays attached to its original revision; new strict work requires valid native receipts. Twelve role contracts include a codebase analyst and a check executor; Cornell notes and three recipes add portable knowledge resources.

Each client launches the package's absolute `dist/cli.js` with the current Node executable. After moving a project or reinstalling the package on another machine, run `update` and review changed native paths.

## Optional CodeGraph provider

The historical descriptor pins `@colbymchenry/codegraph@1.6.2`; its [recorded experiment](codegraph.md) passed twelve Windows C/C++ and freshness checks on a small fixture. Alpha.3 adds automatic installation of applicable approved providers through the scoped gateway, while CodeGraph activation still requires applicable freshness/conformance evidence. Context7 `4.3.0` and Playwright MCP `0.0.83` are also pinned with integrity locks. Required missing capabilities block dispatch, and optional equivalents are recorded. Fixture support does not establish native client discovery. Code discovery complements reviewed engineering traceability.

Native role definitions carry supported tool restrictions. The gateway enforces role/core/provider scope; native filesystem and tool permissions remain governed by the client. Doctor labels configured tools, observed availability, enforced restrictions, and instruction-only limits rather than implying every restriction is enforced by every adapter.

For Playwright, exact task `allowed_urls` checks apply to explicit `browser_navigate` requests. Clicks, typing, key presses, and redirects inherit provider/client network permissions; hard URL containment for those interactions is not established. Arbitrary browser code is outside the approved catalog. The recorded provider run establishes discovery only; browser execution remains unverified.

## Native conformance procedure

For each available authenticated client, record the client version and selected execution surface, then:

1. Confirm VeryThinker instructions and skills are discovered.
2. Invoke a generated agent with a bounded context packet; record requested and confirmed model information.
3. Start the MCP server and invoke a read operation and an authorized mutation.
4. Review native hook trust/settings; observe session-start, tool, and stop events.
5. Disable hooks and verify that completion checks still reject missing evidence.
6. Resume in a new session and confirm access to persisted task and evidence records.

Store actual results and limitations in project evidence. A failed or unavailable native check remains unverified; automated file tests do not upgrade its status.
