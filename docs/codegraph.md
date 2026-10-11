# Optional CodeGraph conformance

The pinned provider `@colbymchenry/codegraph@1.6.2` passed the recorded small Windows C/C++ fixture checks. The result is **supported-for-fixture**, with the provider still **disabled**. This establishes the exercised CLI/MCP behavior on the recorded environment; it does not establish general C/C++ semantic completeness, performance on large projects, or native agent discovery.

The [pinned upstream README](https://github.com/colbymchenry/codegraph/blob/6560052a6f856855d3f71eee838fd66ccfa4285d/README.md) describes a platform-specific bundled runtime, local indexing, CLI queries, and MCP exploration. The experiment below verifies selected behaviors directly. Requirement traceability remains in reviewed VeryThinker engineering records.

## Reproduce the experiment

From the repository or unpacked package:

```text
node scripts/codegraph-check.mjs --install --out codegraph-conformance.json
```

The runner installs the exact package into a newly created temporary sandbox with npm lifecycle scripts disabled. It creates its own fixture, disables telemetry and network fallback, launches the bundled runtime directly, and removes its fixture on completion. It never invokes the provider's native-agent installer and never enables the provider. Use `--package-root PATH` instead of `--install` to reuse an isolated installation.

The JSON report records commands, exit status, timings, stdout/stderr, environment, individual checks, and limitations. Exit code 0 requires every required check to pass. Missing dependencies or failed prerequisites produce unverified checks and exit code 1. Normal unit tests do not download this optional provider.

## Enable the reviewed provider in a project

Use `verythinker codegraph enable --report REPORT --executable EXECUTABLE --args JSON` after reviewing the pinned package and conformance report. `EXECUTABLE` must be an existing absolute executable path. On Windows, use the provider's bundled `node.exe` with its entry script as the first argument, rather than an npm `.cmd` shim. Supply the complete argument array, including `serve`, `--mcp`, and one `--path` followed by the absolute project root. The selected executable is not downloaded automatically.

For a bundled runtime, the argument array has this shape:

```json
["--liftoff-only", "--disable-warning=ExperimentalWarning", "C:\\tools\\codegraph\\node_modules\\@colbymchenry\\codegraph-win32-x64\\lib\\dist\\bin\\codegraph.js", "serve", "--mcp", "--path", "D:\\projects\\example"]
```

Enabling requires all twelve checks for version `1.6.2` to pass on the current Windows platform and architecture. VeryThinker stores a hash-locked report and explicit command in `.verythinker/optional`, then generates native MCP entries. Existing user-owned server entries receive review candidates. Changed reports, missing executables, and incompatible launch arguments restrict the integration. `doctor` reports **supported-for-fixture** with limitations; native client discovery and invocation remain unverified.

## Recorded Windows execution

Final run started **2026-10-11 10:10:12 Asia/Ho_Chi_Minh** (`2026-10-11T03:10:12.592Z`).

The durable [captured JSON report](validation/codegraph-report.json) retains commands, output, timings, and results; machine-specific temporary sandbox paths are replaced with `<temporary-sandbox>` and the redaction is recorded. The report remains disabled by default.

| Property | Observed value |
| --- | --- |
| Provider/package version | `1.6.2` |
| Platform | `win32/x64` |
| OS release | `10.0.26200` |
| Host Node.js | `v24.18.0` |
| Provider's bundled Node.js | `v24.16.0` |
| Fixture | `sensor.h`, `sensor.c`, `controller.cpp`; generated guard/watch C files |
| Initial graph | 3 indexed files, 9 nodes, 10 edges |
| Configuration | Telemetry disabled; direct MCP mode; 100 ms watcher debounce |
| Final result | `supported-for-fixture`, `enabled: false` |

The initial C definition was `sensor_read(void)`. A C++ `Controller.sample` called it through the header, and `control_step` called the class method. The runner later renamed the sensor definition, added/deleted a guard function, and exercised a live watcher with `watch_added` becoming `watch_updated`.

| Check | Actual result |
| --- | --- |
| Version and Windows launch | Provider reported `1.6.2`; launch succeeded |
| C extraction | `sensor_read` indexed from `sensor.c` as language `c` |
| C++ extraction | `control_step` indexed from `controller.cpp` as language `cpp` |
| Cross-file caller | Caller query identified C++ `sample` in `controller.cpp` for C `sensor_read` |
| Explicit modify/sync | `sensor_read` disappeared and `sensor_measure` appeared |
| Explicit add/sync | New `sensor_guard` function appeared |
| Explicit delete/sync | Deleted `sensor_guard` query returned `[]` |
| MCP discovery | Initialize and `tools/list` exposed `codegraph_explore` |
| Reconnect freshness | Edit made while MCP was absent appeared as `sensor_latest(void)` after connection |
| Live addition | Added `watch_added(void)` appeared without explicit sync; final response had no pending-sync warning |
| Live modification | Renamed `watch_updated(void)` returned body `return 19`; final response had no pending-sync warning |
| Indexed rename after watcher | CLI query returned `watch_updated`; old `watch_added` query returned `[]` |
| Staleness signaling | A pending-sync warning was observed before the final live-modification result |

## Commands and observed timings

Each CLI command ran through the resolved bundled Node executable with `--liftoff-only --disable-warning=ExperimentalWarning` and the package's `lib/dist/bin/codegraph.js` entry point. `FIXTURE` below denotes the runner-created absolute temporary path. Machine-specific paths are retained in the local JSON report rather than copied into shared documentation.

| CLI arguments | Exit | Wall time |
| --- | --- | --- |
| `version` | 0 | 307 ms |
| `init FIXTURE` | 0 | 2,244 ms |
| `query sensor_read --path FIXTURE --json` | 0 | 529 ms |
| `query control_step --path FIXTURE --json` | 0 | 488 ms |
| `callers sensor_read --path FIXTURE --json` | 0 | 487 ms |
| `sync FIXTURE` after rename/add | 0 | 1,455 ms |
| `query sensor_read --path FIXTURE --json` | 0 | 464 ms |
| `query sensor_measure --path FIXTURE --json` | 0 | 434 ms |
| `query sensor_guard --path FIXTURE --json` | 0 | 609 ms |
| `sync FIXTURE` after deletion | 0 | 1,207 ms |
| `query sensor_guard --path FIXTURE --json` | 0 | 462 ms |
| `query watch_updated --path FIXTURE --json` | 0 | 414 ms |
| `query watch_added --path FIXTURE --json` | 0 | 456 ms |

MCP used `serve --mcp --path FIXTURE`, followed by `tools/list` and `tools/call` requests to `codegraph_explore` with `projectPath: FIXTURE`. Queries were `sensor_latest`, `watch_added`, and `watch_updated`. The final watched modification produced the new function's source and indexed name after its transient staleness warning cleared.

## Limitations and failed attempt

An intermediate wrapper-based attempt timed out while indexing. Its 60-second command limit was observed at approximately 87 seconds, and the bundled process reported that its parent had exited after termination. The runner was changed to control the actual bundled runtime directly, matching the npm launcher's executable/flags, so shutdown and timeouts act on the process doing the work. The final direct-runtime run completed all checks.

The first exploratory watcher check only looked for current source text. That was insufficient because CodeGraph can return live disk content together with a warning that graph entries remain stale. The final check requires warning-free results and confirms the renamed symbol in the index.

This fixture covers simple C/C++ declarations, one class, calls across files, and add/rename/delete changes. It does not cover preprocessor configurations, templates, overload resolution, large embedded SDKs, symlinked trees, network filesystems, daemon proxy mode, or other platforms. Re-run conformance for the intended environment before enabling the optional provider, and retain the resulting report as project evidence.
