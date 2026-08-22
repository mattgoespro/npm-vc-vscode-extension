import * as vscode from "vscode";
import { AnalysisCache } from "./analysisCache";
import { MarkStore } from "./markStore";
import { isPackageJson } from "./analyzer";
import { bumpRange } from "./semverUtil";

const SOURCE = "npm Version Control";

/**
 * Owns the two diagnostic collections shown in the editor:
 *  - `outdated`: the per-package warnings (which soften to "queued" info once
 *    a package is marked for upgrade).
 *  - `install`: the per-category error placed when `npm install` reports a
 *    dependency conflict.
 *
 * They are kept in separate collections so an install failure never has to be
 * merged by hand with the outdated warnings — VS Code overlays both.
 */
export class DiagnosticsManager {
  private outdated: vscode.DiagnosticCollection;
  private install: vscode.DiagnosticCollection;

  constructor(
    private analysisCache: AnalysisCache,
    private markStore: MarkStore,
  ) {
    this.outdated = vscode.languages.createDiagnosticCollection(
      "npmVersionControl.outdated",
    );
    this.install = vscode.languages.createDiagnosticCollection(
      "npmVersionControl.install",
    );
  }

  async refresh(document: vscode.TextDocument): Promise<void> {
    if (!isPackageJson(document)) {
      return;
    }

    const analysis = await this.analysisCache.get(document);
    const diagnostics: vscode.Diagnostic[] = [];

    for (const category of analysis.categories) {
      for (const pkg of category.packages) {
        if (!pkg.outdated || !pkg.latest) {
          continue;
        }
        const marked = this.markStore.isMarked(
          document.uri,
          category.name,
          pkg.name,
        );

        // The message (and severity) changes with the marked/unmarked state.
        let diagnostic: vscode.Diagnostic;
        if (marked) {
          const nextRange = bumpRange(pkg.range, pkg.latest);
          diagnostic = new vscode.Diagnostic(
            pkg.lineRange,
            `${pkg.name} is queued to upgrade: ${pkg.range} → ${nextRange} ` +
              `(applied on the next npm install).`,
            vscode.DiagnosticSeverity.Information,
          );
        } else {
          diagnostic = new vscode.Diagnostic(
            pkg.lineRange,
            `${pkg.name} ${pkg.range} is outdated — ${pkg.latest} is available. ` +
              `Use the "Mark to upgrade" lens to queue an upgrade.`,
            vscode.DiagnosticSeverity.Warning,
          );
        }
        diagnostic.source = SOURCE;
        diagnostic.code = pkg.name;
        diagnostics.push(diagnostic);
      }
    }

    this.outdated.set(document.uri, diagnostics);
  }

  setInstallError(uri: vscode.Uri, range: vscode.Range, message: string): void {
    const diagnostic = new vscode.Diagnostic(
      range,
      message,
      vscode.DiagnosticSeverity.Error,
    );
    diagnostic.source = SOURCE;
    this.install.set(uri, [diagnostic]);
  }

  clearInstallError(uri: vscode.Uri): void {
    this.install.delete(uri);
  }

  clear(uri: vscode.Uri): void {
    this.outdated.delete(uri);
    this.install.delete(uri);
  }

  dispose(): void {
    this.outdated.dispose();
    this.install.dispose();
  }
}
