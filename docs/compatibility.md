# Native client compatibility

VeryThinker installs project-local adapters. Generated files are checked by automated tests; discovery and execution in authenticated native sessions remain **unverified** until a recorded conformance run confirms them. Finding an executable or a configuration file does not establish native behavior or model availability.

## Supported installation targets

| Target | Generated integration | Verification status |
| --- | --- | --- |
| Codex local CLI/desktop/IDE | `AGENTS.md`, `.agents/skills`, `.codex/agents/*.toml`, project MCP and lifecycle hooks | Structural generation tested; native discovery and trust unverified |
| Claude Code local | `CLAUDE.md`, `.claude/skills`, `.claude/agents/*.md`, portable MCP and lifecycle hooks | Structural generation tested; native discovery and execution unverified |
| GitHub Copilot in VS Code | Repository instructions, `.github/skills`, `.github/agents/*.agent.md`, portable MCP and repository hooks | Structural generation tested; extension version, agent host, and native execution unverified |
| Remote/cloud clients | Local adapters may contain machine-specific absolute paths | Restricted; install on the execution host and record a separate conformance run |

`doctor` reports runtime support, generated file presence, executable availability, requested model mappings, and limitations. It leaves skill discovery, effective model selection, MCP invocation, and hook execution unverified until native evidence exists. Native executable versions are observed only when the executable can safely run with `--version`; Windows batch shims are reported without executing a shell.

## Format decisions and official references

- Codex agent definitions use TOML files in `.codex/agents` with role instructions and an optional requested model. Project MCP uses `.codex/config.toml`. Hook groups use `SessionStart`, `PostToolUse`, and `Stop`, with Windows command overrides. New or changed hooks require native trust review. [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), [hooks](https://learn.chatgpt.com/docs/hooks).
- Claude Code uses project agent Markdown frontmatter. A missing requested model uses `inherit`. Current documented hooks support executable `command` plus `args` directly, with no shell. The generated session-start handler was executed locally from a project path containing spaces; client discovery remains unverified. Older clients require a separate conformance check. [Subagents](https://code.claude.com/docs/en/sub-agents), [hook execution](https://code.claude.com/docs/en/hooks).
- Claude Code and current VS Code documentation both support portable root `.mcp.json` with `mcpServers`. VeryThinker generates a single shared server entry. Older VS Code clients can require an explicit `.vscode/mcp.json` conversion; such clients remain unverified. [Claude MCP](https://code.claude.com/docs/en/mcp), [VS Code MCP configuration](https://code.visualstudio.com/docs/agent-customization/mcp-servers).
- Copilot repository hooks use the version 1 lower camel case format. VS Code documents conversion of this format to its local hook format. Effective hook support depends on the selected client surface. [Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference), [VS Code hooks](https://code.visualstudio.com/docs/agent-customization/hooks).
- Copilot agents use `.agent.md` frontmatter. Model selection remains subject to client support and account availability. [Custom agents configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration).

References were checked on 2026-10-11. Compatibility is assessed by client surface and observed version, rather than the provider name alone.

## Model routing

Project model tiers are requested mappings. An unset mapping inherits the platform's selection. VeryThinker does not query account entitlements or claim that a requested model actually ran. Each work record must distinguish requested model, confirmed model, and unavailable observations.

Hooks are advisory: disabling or rejecting them does not bypass CLI verification. MCP configuration alone does not grant trust or prove that a tool was invoked.

## Installation and updates

The installer tracks managed files, marked instruction blocks, and individual JSON configuration entries with SHA-256 hashes and a package version. It preserves comments and sibling settings. Existing user-owned VeryThinker keys, malformed settings, edited files, and deleted managed content produce `.verythinker-update` candidates. Edited candidate files are also preserved by creating a numbered candidate. Review candidates explicitly; even `force` preserves user edits.

Each client launches the package's absolute `dist/cli.js` with the current Node executable. After moving a project or reinstalling the package on another machine, run `update` and review changed native paths.

## Optional CodeGraph provider

The installed descriptor pins `@colbymchenry/codegraph@1.6.2` and defaults to disabled/unverified. Installation does not download or enable CodeGraph. The [recorded experiment](codegraph.md) passed all twelve Windows C/C++ and freshness checks on its small fixture. Explicit project enablement requires this evidence, a matching Windows platform/architecture, and a supplied absolute executable with complete server arguments. Reports are hash-locked and native entries preserve existing configuration. Fixture support does not establish native client discovery. Its code graph assists discovery; reviewed engineering records retain requirement traceability.

## Native conformance procedure

For each available authenticated client, record the client version and selected execution surface, then:

1. Confirm VeryThinker instructions and skills are discovered.
2. Invoke a generated agent with a bounded context packet; record requested and confirmed model information.
3. Start the MCP server and invoke a read operation and an authorized mutation.
4. Review native hook trust/settings; observe session-start, tool, and stop events.
5. Disable hooks and verify that completion checks still reject missing evidence.
6. Resume in a new session and confirm access to persisted task and evidence records.

Store actual results and limitations in project evidence. A failed or unavailable native check remains unverified; automated file tests do not upgrade its status.
