# Software pilot: persistent configuration

This pilot implements a small JSON configuration service using Node.js standard libraries. It is independent of an agent platform.

## Requirements and verification

| Requirement | Behavior | Check |
| --- | --- | --- |
| SW-REQ-001 | Accept schema version 1, integer ports 1–65535, and debug/info/warn/error log levels; reject missing, extra, or invalid fields. | SW-CHECK-001 |
| SW-REQ-002 | Return defaults when the file is missing; save validated configuration so a new process can read it. | SW-CHECK-002, SW-CHECK-003 |
| SW-REQ-003 | An invalid save must preserve the existing file. Corrupt files must produce an error and remain unchanged. | SW-CHECK-002, SW-CHECK-003 |
| SW-REQ-004 | CLI get/set operations return JSON; invalid input exits unsuccessfully with an English diagnostic. | SW-CHECK-003 |

## Design and interface

`validateConfig(value)` returns a normalized object or throws. `loadConfig(file)` and `saveConfig(file, value)` are asynchronous. Missing files return `{ "schemaVersion": 1, "port": 8080, "logLevel": "info" }`.

Saving writes and syncs a unique temporary file in the destination directory, then renames it over the destination. Failed validation happens before filesystem changes. This prevents readers from seeing a partially written JSON file. Concurrent writers use last-writer-wins behavior. Directory metadata is not synced: this example does not promise survival across sudden power loss.

## Run

```sh
node --test examples/software/tests/config.test.mjs
node examples/software/cli.mjs set ./config.json '{"schemaVersion":1,"port":3000,"logLevel":"debug"}'
node examples/software/cli.mjs get ./config.json
```

On PowerShell, pass JSON as a single-quoted string as shown. The test suite launches separate processes to verify persistence.

## Verification boundary

The checks cover validation, file preservation, missing/corrupt files, overwrite, and process restart. They do not test power-loss behavior, network filesystems, or production service availability. Test output is evidence only for the source revision on which it ran; see `../verification.json` when an evidence snapshot has been generated.
