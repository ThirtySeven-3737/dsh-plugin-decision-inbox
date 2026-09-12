# Contributing

Thanks for taking a look at `dsh-decision-inbox`.

## Development setup

```powershell
pnpm install
pnpm check
pnpm test
pnpm build
```

The normal test suite does not require a model API key. The optional autonomy eval uses a real model boundary:

```powershell
pnpm eval:autonomy
```

Set `DEEPSEEK_API_KEY` or provide a local `env.txt`. Do not commit keys or local eval output.

## Pull request checklist

- Keep model-visible guidance natural: users should not need to know this plugin exists.
- Do not use this plugin for permissions, secrets, authentication, or destructive-action approval.
- Add or update tests for runtime, persistence, UI/RPC, import/export, sync, and prompt-policy behavior as relevant.
- Run `pnpm check` and `pnpm test` before sending a PR.
- Run `pnpm build` before packaging or installing into a DSH profile.

## Repository hygiene

Ignored local artifacts include `node_modules/`, `lib/`, `*.tgz`, `.test-dsh-home/`, `env.txt`, and manual test workspaces. Keep generated packages and local DSH state out of commits.

