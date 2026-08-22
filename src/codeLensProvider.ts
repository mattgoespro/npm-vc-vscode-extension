import * as vscode from "vscode";
import { AnalysisCache } from "./analysisCache";
import { MarkStore } from "./markStore";
import { isPackageJson } from "./analyzer";

export const TOGGLE_COMMAND = "npmVersionControl.toggleMark";
export const INSTALL_COMMAND = "npmVersionControl.install";

/**
 * Provides two kinds of code lenses:
 *  - a per-package lens on each outdated dependency to mark/unmark it for upgrade
 *  - a per-category lens (on the `dependencies` / `devDependencies` / ... key)
 *    that runs `npm install`, applying any queued upgrades in that category.
 */
export class DependencyCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  constructor(
    private analysisCache: AnalysisCache,
    private markStore: MarkStore,
  ) {
    // Re-render lenses when marks toggle or a fresh analysis lands.
    this.markStore.onDidChange(() => this.changeEmitter.fire());
    this.analysisCache.onDidAnalyze(() => this.changeEmitter.fire());
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    if (!isPackageJson(document)) {
      return [];
    }

    const analysis = await this.analysisCache.get(document);
    if (token.isCancellationRequested) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];

    for (const category of analysis.categories) {
      const markedInCategory = category.packages.filter((pkg) =>
        this.markStore.isMarked(document.uri, category.name, pkg.name),
      ).length;

      // Category-level install lens (always present for a declared category).
      const installTitle =
        markedInCategory > 0
          ? `$(cloud-download) npm install — apply ${markedInCategory} queued upgrade${
              markedInCategory === 1 ? "" : "s"
            }`
          : "$(cloud-download) npm install";
      lenses.push(
        new vscode.CodeLens(category.keyRange, {
          title: installTitle,
          command: INSTALL_COMMAND,
          arguments: [document.uri, category.name],
        }),
      );

      // Per-package upgrade toggles (only for genuinely outdated packages).
      for (const pkg of category.packages) {
        if (!pkg.outdated || !pkg.latest) {
          continue;
        }
        const marked = this.markStore.isMarked(
          document.uri,
          category.name,
          pkg.name,
        );
        const title = marked
          ? `$(check) Queued to upgrade to ${pkg.latest} — click to unmark`
          : `$(arrow-up) Mark to upgrade to ${pkg.latest}`;
        lenses.push(
          new vscode.CodeLens(pkg.lineRange, {
            title,
            command: TOGGLE_COMMAND,
            arguments: [document.uri, category.name, pkg.name],
          }),
        );
      }
    }

    return lenses;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
