import * as vscode from "vscode";
import { analyzeDocument, DocumentAnalysis } from "./analyzer";
import { RegistryClient } from "./registry";

interface CacheSlot {
  version: number;
  promise: Promise<DocumentAnalysis>;
}

/**
 * Memoizes {@link analyzeDocument} by document version so that the code-lens
 * provider and the diagnostics layer share a single analysis (and thus a single
 * batch of registry lookups) per edit.
 */
export class AnalysisCache {
  private slots = new Map<string, CacheSlot>();
  private readonly readyEmitter =
    new vscode.EventEmitter<vscode.TextDocument>();
  /** Fires once an analysis for a document finishes (results may have changed). */
  readonly onDidAnalyze = this.readyEmitter.event;

  constructor(private registry: RegistryClient) {}

  get(document: vscode.TextDocument): Promise<DocumentAnalysis> {
    const key = document.uri.toString();
    const existing = this.slots.get(key);
    if (existing && existing.version === document.version) {
      return existing.promise;
    }

    const promise = analyzeDocument(document, this.registry).then(
      (analysis) => {
        // Only announce readiness if this is still the newest analysis; a newer
        // edit may have superseded us while awaiting the network.
        const current = this.slots.get(key);
        if (current && current.version === document.version) {
          this.readyEmitter.fire(document);
        }
        return analysis;
      },
    );

    this.slots.set(key, { version: document.version, promise });
    return promise;
  }

  invalidate(uri: vscode.Uri): void {
    this.slots.delete(uri.toString());
  }

  clear(): void {
    this.slots.clear();
  }

  dispose(): void {
    this.readyEmitter.dispose();
  }
}
