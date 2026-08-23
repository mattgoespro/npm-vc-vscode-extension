# npm Version Control

A Visual Studio Code extension that turns any `package.json` into a live dependency
manager.

When you open a `package.json` file, the extension:

1. **Highlights outdated packages.** Every line that declares a dependency whose
   latest published version is newer than the range in your file gets a warning
   diagnostic showing the current range and the latest version.
2. **Lets you queue upgrades with a code lens.** Each outdated package shows a
   `⬆ Mark to upgrade to X.Y.Z` code lens; clicking it toggles the package's
   marked state. The diagnostic message and severity change to reflect the new
   state so you can see at a glance what's queued.
3. **Installs on demand.** Every dependency category (`dependencies`,
   `devDependencies`, `peerDependencies`, `optionalDependencies`) gets a
   `📥 npm install` code lens. Clicking it rewrites the version strings of any
   marked packages in that category to the latest version (preserving the `^` or
   `~` range prefix), saves the file, and runs `npm install` in that folder.
4. **Shows install output in a dedicated panel.** All install output lands in the
   **npm Version Control** output channel, which opens automatically on install.
   If `npm install` fails with a peer-dependency conflict (`ERESOLVE`,
   `conflicting peer dependency`), an error diagnostic is placed on the
   category's key line so the failure is anchored right next to what caused it.

## Settings

- `npmVersionControl.registry` — override the npm registry base URL.
- `npmVersionControl.cacheTtlSeconds` — how long to cache registry lookups.
