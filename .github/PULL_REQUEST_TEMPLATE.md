## Summary

<!-- Briefly explain what this PR changes and why. Link related issues (e.g. Fixes #123). -->

## Checklist

- [ ] Target branch is `dev` (only release PRs from `dev` or urgent `hotfix/*` PRs target `main`)
- [ ] Ran `npm run typecheck`
- [ ] Ran `npm run build` and committed updated `dist/*.mjs` bundles (if `src/` changed)
- [ ] Ran `npm test` (and `npm run validate` if `plugin.json` / `hooks.json` / `mcp_config.json` / `rules/` changed)
- [ ] Added or updated unit tests for new behavior or bug fixes
