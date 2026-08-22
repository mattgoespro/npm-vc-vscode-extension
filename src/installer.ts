import * as vscode from "vscode";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import { AnalysisCache } from "./analysisCache";
import { MarkStore } from "./markStore";
import { DiagnosticsManager } from "./diagnostics";
import { bumpRange } from "./semverUtil";
import { CategoryInfo } from "./analyzer";

/** Signatures in npm output that indicate an unresolved dependency conflict. */
const CONFLICT_PATTERNS = [
  /ERESOLVE/i,
  /could not resolve dependency/i,
  /conflicting peer dependency/i,
  /unable to resolve dependency tree/i,
];

interface InstallResult {
  code: number | null;
  combined: string;
  cancelled: boolean;
}

/**
 * Applies queued upgrades and runs `npm install`, streaming output to a
 * dedicated Output channel and flagging peer-dependency conflicts on the
 * category line.
 *
 * Visibility while npm is running comes from three places at once:
 *  - a `withProgress` notification with an elapsed-seconds counter and a
 *    Cancel button (persistent in the corner, no matter what pane is focused),
 *  - the Output panel, which is auto-revealed on install and receives
 *    line-buffered stdout/stderr from npm at `--loglevel=http` by default so
 *    there is real activity even before the "added N packages" summary, and
 *  - a status-bar item that shows a spinning icon while the install runs.
 */
export class Installer {
  private output: vscode.OutputChannel;
  private statusBar: vscode.StatusBarItem;
  /** Guards against two installs racing in the same folder. */
  private running = new Set<string>();

  constructor(
    private analysisCache: AnalysisCache,
    private markStore: MarkStore,
    private diagnostics: DiagnosticsManager,
  ) {
    this.output = vscode.window.createOutputChannel("npm Version Control");
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.statusBar.command = "npmVersionControl.showOutput";
    this.statusBar.tooltip = "Click to open the npm Version Control output panel.";
  }

  async install(uri: vscode.Uri, categoryName: string): Promise<void> {
    const cwd = path.dirname(uri.fsPath);
    if (this.running.has(cwd)) {
      vscode.window.showWarningMessage(
        `npm install is already running in ${path.basename(cwd)}.`,
      );
      return;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const analysis = await this.analysisCache.get(document);
    const category = analysis.categories.find((c) => c.name === categoryName);
    if (!category) {
      return;
    }

    // 1. Apply any queued upgrades in this category to the file's text.
    const applied = await this.applyQueuedUpgrades(document, category);

    // A fresh install invalidates any previous conflict marker.
    this.diagnostics.clearInstallError(uri);

    // 2. Prime the output panel so users know work has started even before
    // npm produces its first line of output.
    this.output.show(true);
    this.output.appendLine("");
    this.output.appendLine(`$ npm install   (cwd: ${cwd})`);
    if (applied.length > 0) {
      this.output.appendLine(
        `  applying queued upgrades: ${applied
          .map((a) => `${a.name}→${a.to}`)
          .join(", ")}`,
      );
    }
    this.output.appendLine(
      "  (resolving dependency tree — this can take a few seconds before npm produces its first line of output)",
    );

    this.running.add(cwd);
    this.showStatusBar(`starting…`);
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title:
            applied.length > 0
              ? `npm install — applying ${applied.length} upgrade${
                  applied.length === 1 ? "" : "s"
                } in ${path.basename(cwd) || cwd}`
              : `npm install in ${path.basename(cwd) || cwd}`,
          cancellable: true,
        },
        async (progress, token) => {
          progress.report({ message: "starting npm…" });
          const started = Date.now();
          // Update the notification (and the status bar) once a second so the
          // user can see the install is still alive during slow phases.
          const tick = setInterval(() => {
            const seconds = Math.floor((Date.now() - started) / 1000);
            const message = `still working… ${seconds}s elapsed`;
            progress.report({ message });
            this.showStatusBar(`${seconds}s`);
          }, 1000);

          try {
            const result = await this.runNpmInstall(cwd, token);
            if (result.cancelled) {
              this.output.appendLine("⚠ npm install cancelled by user.");
              return;
            }
            if (result.code === 0) {
              this.output.appendLine(
                `✔ npm install completed successfully (exit 0).`,
              );
              // Marks are consumed once their upgrade is installed.
              this.markStore.clearMarks(
                uri,
                applied.map((a) => ({ category: categoryName, name: a.name })),
              );
            } else {
              this.output.appendLine(
                `✖ npm install failed (exit ${result.code}).`,
              );
              this.handleFailure(uri, category, result.combined);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.output.appendLine(`✖ Failed to launch npm: ${message}`);
            this.diagnostics.setInstallError(
              uri,
              category.keyRange,
              `Could not run npm install: ${message}`,
            );
          } finally {
            clearInterval(tick);
          }
        },
      );
    } finally {
      this.running.delete(cwd);
      this.hideStatusBar();
      // Re-analyze so warnings reflect the newly written versions.
      this.analysisCache.invalidate(uri);
    }
  }

  /** Explicitly reveal the output panel — used by the status-bar item. */
  showOutput(): void {
    this.output.show(true);
  }

  /** Rewrite version strings of marked packages to the latest version. */
  private async applyQueuedUpgrades(
    document: vscode.TextDocument,
    category: CategoryInfo,
  ): Promise<Array<{ name: string; from: string; to: string }>> {
    const edit = new vscode.WorkspaceEdit();
    const applied: Array<{ name: string; from: string; to: string }> = [];

    for (const pkg of category.packages) {
      if (!pkg.outdated || !pkg.latest) {
        continue;
      }
      if (!this.markStore.isMarked(document.uri, category.name, pkg.name)) {
        continue;
      }
      const next = bumpRange(pkg.range, pkg.latest);
      if (next === pkg.range) {
        continue;
      }
      edit.replace(document.uri, pkg.valueRange, next);
      applied.push({ name: pkg.name, from: pkg.range, to: next });
    }

    if (applied.length > 0) {
      await vscode.workspace.applyEdit(edit);
      await document.save();
    }
    return applied;
  }

  private handleFailure(
    uri: vscode.Uri,
    category: CategoryInfo,
    output: string,
  ): void {
    const isConflict = CONFLICT_PATTERNS.some((re) => re.test(output));
    if (isConflict) {
      this.diagnostics.setInstallError(
        uri,
        category.keyRange,
        "npm install failed: unresolved dependency conflict (ERESOLVE). " +
          'See the "npm Version Control" output panel for details.',
      );
      vscode.window
        .showErrorMessage(
          "npm install failed due to a dependency conflict.",
          "Show Output",
        )
        .then((choice) => {
          if (choice === "Show Output") {
            this.output.show(true);
          }
        });
    } else {
      this.diagnostics.setInstallError(
        uri,
        category.keyRange,
        'npm install failed. See the "npm Version Control" output panel for details.',
      );
    }
  }

  private runNpmInstall(
    cwd: string,
    token: vscode.CancellationToken,
  ): Promise<InstallResult> {
    return new Promise((resolve, reject) => {
      const logLevel = vscode.workspace
        .getConfiguration("npmVersionControl")
        .get<string>("npmLogLevel", "http");
      const args = ["install", `--loglevel=${logLevel}`];

      // `shell: true` lets Windows resolve `npm` to `npm.cmd` without us having
      // to special-case the extension. The tradeoff is that on Windows the
      // direct child is the shell, so we must kill the process tree (below).
      const child = spawn("npm", args, { cwd, shell: true });
      let combined = "";
      let cancelled = false;

      const pump = (data: Buffer) => {
        const text = data.toString();
        combined += text;
        // Keep the panel readable — write without adding extra blank lines.
        this.output.append(text);
      };

      child.stdout.on("data", pump);
      child.stderr.on("data", pump);

      const cancelSub = token.onCancellationRequested(() => {
        cancelled = true;
        this.output.appendLine("… cancelling npm install …");
        killTree(child);
      });

      child.on("error", (err) => {
        cancelSub.dispose();
        reject(err);
      });
      child.on("close", (code) => {
        cancelSub.dispose();
        resolve({ code, combined, cancelled });
      });
    });
  }

  private showStatusBar(detail: string): void {
    this.statusBar.text = `$(sync~spin) npm install${detail ? " · " + detail : ""}`;
    this.statusBar.show();
  }

  private hideStatusBar(): void {
    this.statusBar.hide();
  }

  dispose(): void {
    this.output.dispose();
    this.statusBar.dispose();
  }
}

/**
 * Kill the whole process tree so cancelling actually stops npm on Windows,
 * where the direct child is the shell and killing it leaves node/npm running.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], {
        stdio: "ignore",
      });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    // Best effort — the child.on("close") handler will still resolve when
    // the process eventually exits.
  }
}
