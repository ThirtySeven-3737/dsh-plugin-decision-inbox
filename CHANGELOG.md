# Changelog

## 0.5.0

- Added autonomous, model-visible policy guidance for consequential user choices.
- Added DSH Web decision card with one-click options and free-text answers.
- Added durable JSON persistence, append-only audit logging, answer outbox retry, and idempotent delivery handling.
- Added audit export APIs and `/decision export` for CSV, JSON, and NDJSON.
- Added historical decision import APIs and `/decision import`.
- Added remote sync APIs for long-term external tool integration, including versioned snapshots and remote answer/cancel submission handling.
- Added optional HTTP sync routes on the shared DSH host web server with loopback/trusted-host fencing and optional bearer token protection.
- Added automated tests covering runtime behavior, persistence, Web UI/RPC, import/export, audit logging, remote sync, HTTP routes, and end-to-end WebServer integration.

