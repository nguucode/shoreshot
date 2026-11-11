# ShoreShot

Project info (status, decisions, research) lives in the Obsidian vault, not in this repo:
@/Volumes/KAFKA/Vault/10-projects/shoreshot/_context.md

- Before writing to the vault, read `/Volumes/KAFKA/Vault/CLAUDE.md` (frontmatter, `_context.md`, `_system/agent-log.md`).
- Everything in this repo is English: UI text, dialogs, installer output, README, code comments, commits, PRs.
- User-facing docs: `README.md`. Keep it in sync with the code (shortcuts, install, release steps).
- Dev: `cd app-tauri && npm run dev`. Installers: `sh app-tauri/bundle-mac.sh` (mac), `npx tauri build --bundles nsis` (Windows). See `app-tauri/PORTING.md`.
- Release: bump `version` in `package.json`, then push a `v*` tag or run the **build** workflow with **release** ticked.
- Drive is exFAT: use `npm`, not `pnpm` (no hardlinks).
