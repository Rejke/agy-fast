# Contributing to `agy-fast`

Thanks for contributing! `agy-fast` uses a protected **`main` + `dev`** branching model so `main` stays releasable and safe for one-command installers (`install.sh` / `install.ps1`) and direct `git clone` users.

## Branching Model

| Branch | Role | Protection |
| :--- | :--- | :--- |
| `main` | Stable released code only (`vX.Y.Z` tags) | Protected: PR + passing Linux/Windows CI & stress benchmark required; no direct push, force-push, or deletion |
| `dev` | Active integration branch for upcoming releases | Protected against deletion & force-push; default target for feature/fix PRs and Dependabot |
| `feat/*`, `fix/*`, `docs/*` | Short-lived topic branches branched from `dev` | Automatically deleted after PR merge |
| `hotfix/*` | Urgent production fixes branched from `main` | PR into `main`, then back-merged into `dev` |

## Submitting a Pull Request

1. Branch off `dev`:
   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b fix/your-topic
   ```
2. Make your edits and rebuild the bundled runtime outputs if you touched `src/`:
   ```bash
   npm run typecheck
   npm run build
   npm test
   ```
   If you also changed `plugin.json`, `mcp_config.json`, `hooks.json`, or `rules/AGENTS.md`, run:
   ```bash
   npm run validate
   ```
3. Open a PR targeting **`dev`**. CI will automatically verify Linux + Windows (`verify (ubuntu-latest)`, `verify (windows-latest)`), `dist/` bundle freshness, and the 11-scenario stress suite (`stress`).

## Release Flow (Maintainers)

1. On `dev`, bump `version` in `package.json` and `plugin.json`, add the `## [X.Y.Z] - YYYY-MM-DD` section to `CHANGELOG.md`, run `npm run typecheck && npm run build && npm test && npm run validate && npm run bench:stress`, and commit.
2. Open a Release PR from `dev` → `main` and wait for all required CI checks (`verify (ubuntu-latest)`, `verify (windows-latest)`, `stress`) to pass.
3. Merge using **Create a merge commit** (avoid Squash on `dev` → `main` so branch history stays aligned), pull the merged `main`, and push the tag `vX.Y.Z`:
   ```bash
   git checkout main && git pull origin main
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
   Pushing `vX.Y.Z` automatically triggers `.github/workflows/release.yml`, which verifies the tag is on `main`, checks version parity & tests, extracts notes from `CHANGELOG.md`, and publishes the GitHub Release (tags matching `v*` are protected once pushed).
4. Fast-forward/sync `dev` with `main` (`git checkout dev && git merge main && git push origin dev`) so the next release cycle stays conflict-free.
