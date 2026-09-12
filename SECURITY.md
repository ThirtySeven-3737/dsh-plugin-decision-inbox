# Security Policy

## Supported status

This plugin is experimental and currently tested against DeepSeek Harness `0.1.0-rc.5` packages. APIs may change with DSH.

## Reporting security issues

If this repository is published on GitHub, please report security issues privately through GitHub Security Advisories when enabled. Until then, contact the repository maintainer directly and avoid opening public issues for vulnerabilities.

## Scope and boundaries

- `dsh-decision-inbox` is not an approval or permission system.
- It must not be used for secrets, authentication consent, destructive-action approval, or security-sensitive confirmation flows.
- Remote sync HTTP routes default to loopback-only trust checks. If exposed beyond loopback, configure a long random `sync.token` and an explicit `sync.trustedHosts` allowlist.
- The JSON persistence backend is single-writer. Running multiple DSH processes against the same `DSH_HOME` is not coordinated.

