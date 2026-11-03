# ShoreShot

Project info (status, decisions, research) lives in the Obsidian vault, not in this repo:
@/Volumes/KAFKA/Vault/10-projects/shoreshot/_context.md

- Before writing to the vault, read `/Volumes/KAFKA/Vault/CLAUDE.md` (frontmatter, `_context.md`, `_system/agent-log.md`).
- User-facing docs: `README.md`. Keep it in sync with the code (shortcuts, install, release steps).
- Dev: `npm start`, `npm run build` (tsc). Installers: `npm run dist:mac` / `npm run dist:win`.
- Release: bump `version` in `package.json`, then push a `v*` tag or run the **build** workflow with **release** ticked.
- Drive is exFAT: use `npm`, not `pnpm` (no hardlinks).
