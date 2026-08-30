<p align="center">
  <img src="icon.png" alt="npm Version Control" width="168" height="168">
</p>

<h1 align="center">npm Version Control</h1>

<p align="center">
  <strong>Turn every <code>package.json</code> into a live dependency manager.</strong><br>
  See what’s outdated. Queue upgrades. Run <code>npm install</code> — without leaving the editor.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=mattgoespro.npm-vc-vscode-extension"><img src="https://img.shields.io/visual-studio-marketplace/v/mattgoespro.npm-vc-vscode-extension?style=for-the-badge&amp;label=VS%20Marketplace&amp;color=2E7D32" alt="VS Marketplace version"></a>
  <a href="https://open-vsx.org/extension/mattgoespro/npm-vc-vscode-extension"><img src="https://img.shields.io/open-vsx/v/mattgoespro/npm-vc-vscode-extension?style=for-the-badge&amp;label=Open%20VSX&amp;color=1B5E20" alt="Open VSX version"></a>
  <img src="https://img.shields.io/badge/license-MIT-2E7D32?style=for-the-badge" alt="MIT License">
</p>

---
\
Open a `package.json` and the file itself becomes the UI: warnings on stale ranges, code lenses to queue upgrades, and one-click install per dependency category.

| Highlight | Queue | Install |
| :---: | :---: | :---: |
| **Warning diagnostics** on every outdated range, with the latest published version | **Code lens** on each stale package — mark it, or click again to unmark | **`npm install` lens** on `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies` |

Queued packages switch from a warning to an info diagnostic so you can see the upgrade list at a glance before anything is written.

---

## How it works

1. **Open `package.json`.** Outdated comparable ranges are underlined and explained in the Problems panel.
2. **Mark what you want.** Click `Mark to upgrade to x.y.z` on a package. Click again to unmark it.
3. **Install that category.** Click `npm install` on the category key. Marked ranges are rewritten to the latest version (**`^` / `~` prefixes are kept**), the file is saved, and `npm install` runs in that folder.
4. **Watch the result.** Output streams into the **npm Version Control** channel. Peer-dependency conflicts (`ERESOLVE`) land as an error diagnostic on the category key — next to the line that caused them.

```json
{
  "dependencies": {
    "lodash": "4.17.0",   // ⚠ outdated — mark to upgrade to 4.17.21
    "semver": "~7.0.0"    // ℹ queued — ~7.7.2 applied on next install
  }
}
```

Non-comparable specs (`file:`, `git:`, `workspace:`, `latest`, `*`, …) are skipped so local and git dependencies stay untouched.

---

## Commands

| Command | What it does |
| --- | --- |
| **npm Version Control: Toggle upgrade mark on package** | Mark or unmark a dependency for upgrade |
| **npm Version Control: Install (and apply queued upgrades)** | Rewrite marked ranges and run `npm install` |
| **npm Version Control: Refresh outdated info** | Clear the registry cache and re-analyze the file |
| **npm Version Control: Show output panel** | Focus the install log |

---

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `npmVersionControl.registry` | `https://registry.npmjs.org` | Registry base URL for version lookups |
| `npmVersionControl.cacheTtlSeconds` | `300` | How long to cache those lookups |
| `npmVersionControl.npmLogLevel` | `http` | `npm --loglevel` used for in-editor installs (`http` and above stream registry progress) |

---

<p align="center">
  <sub>Requires npm on your <code>PATH</code>. Works in VS Code and Cursor (VS Code engine <code>^1.125.0</code>).</sub>
</p>
