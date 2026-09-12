# Release Checklist

Use this before publishing to GitHub or npm.

## Before the first GitHub push

- [ ] Choose the final GitHub owner/repository name.
- [ ] Add real `repository`, `homepage`, and `bugs` fields to `package.json`.
- [ ] Initialize git and review the staged file list.
- [ ] Confirm ignored local artifacts are not staged: `node_modules/`, `lib/`, `*.tgz`, `.test-dsh-home/`, `tests/e2e-workspace/`, manual test workspaces, and `env.txt`.
- [ ] Run `pnpm check`.
- [ ] Run `pnpm test`.
- [ ] Review `README.md`, `SECURITY.md`, and `CONTRIBUTING.md`.

## Before npm publishing

- [ ] Run `pnpm build`.
- [ ] Run `pnpm pack --dry-run` or inspect `pnpm pack` output.
- [ ] Confirm the tarball contains only `lib`, `cordis.patch.yml`, `README.md`, `CHANGELOG.md`, `LICENSE`, and package metadata.
- [ ] Re-test installing the packed tarball into a local DSH `web` profile.
