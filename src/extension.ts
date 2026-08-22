import * as vscode from "vscode";
import { RegistryClient } from "./registry";
import { AnalysisCache } from "./analysisCache";
import { MarkStore } from "./markStore";
import { DiagnosticsManager } from "./diagnostics";
import { Installer } from "./installer";
import {
  DependencyCodeLensProvider,
  TOGGLE_COMMAND,
  INSTALL_COMMAND,
} from "./codeLensProvider";
import { isPackageJson } from "./analyzer";

const REFRESH_COMMAND = "npmVersionControl.refresh";
const CHANGE_DEBOUNCE_MS = 500;

function readConfig(): { registry: string; ttl: number } {
  const config = vscode.workspace.getConfiguration("npmVersionControl");
  return {
    registry: config.get<string>("registry", "https://registry.npmjs.org"),
    ttl: config.get<number>("cacheTtlSeconds", 300),
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const { registry: registryBase, ttl } = readConfig();
  const registry = new RegistryClient(registryBase, ttl);
  const analysisCache = new AnalysisCache(registry);
  const markStore = new MarkStore();
  const diagnostics = new DiagnosticsManager(analysisCache, markStore);
  const installer = new Installer(analysisCache, markStore, diagnostics);
  const codeLensProvider = new DependencyCodeLensProvider(
    analysisCache,
    markStore,
  );

  context.subscriptions.push(
    analysisCache,
    markStore,
    diagnostics,
    installer,
    codeLensProvider,
  );

  // Keep diagnostics in step with fresh analyses and mark toggles.
  const refreshDiagnostics = (document: vscode.TextDocument) => {
    void diagnostics.refresh(document);
  };
  context.subscriptions.push(
    analysisCache.onDidAnalyze(refreshDiagnostics),
    markStore.onDidChange((uri) => {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === uri.toString(),
      );
      if (doc) {
        refreshDiagnostics(doc);
      }
    }),
  );

  // Register the code-lens provider for JSON documents (we filter to
  // package.json inside the provider).
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { language: "json", scheme: "file", pattern: "**/package.json" },
        { language: "jsonc", scheme: "file", pattern: "**/package.json" },
      ],
      codeLensProvider,
    ),
  );

  // Commands.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      TOGGLE_COMMAND,
      (uri: vscode.Uri, category: string, name: string) => {
        markStore.toggle(uri, category, name);
      },
    ),
    vscode.commands.registerCommand(
      INSTALL_COMMAND,
      (uri: vscode.Uri, category: string) => {
        void installer.install(uri, category);
      },
    ),
    vscode.commands.registerCommand(REFRESH_COMMAND, () => {
      registry.clear();
      analysisCache.clear();
      codeLensProvider.refresh();
      const editor = vscode.window.activeTextEditor;
      if (editor && isPackageJson(editor.document)) {
        refreshDiagnostics(editor.document);
      }
    }),
    vscode.commands.registerCommand("npmVersionControl.showOutput", () => {
      installer.showOutput();
    }),
  );

  // React to configuration changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("npmVersionControl")) {
        const next = readConfig();
        registry.update(next.registry, next.ttl);
        analysisCache.clear();
        codeLensProvider.refresh();
      }
    }),
  );

  // Analyze on open / save immediately, and on edit with a debounce so we don't
  // re-parse and hit the registry cache on every keystroke.
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  const scheduleRefresh = (
    document: vscode.TextDocument,
    immediate: boolean,
  ) => {
    if (!isPackageJson(document)) {
      return;
    }
    const key = document.uri.toString();
    const existing = debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
      debounceTimers.delete(key);
    }
    const run = () => {
      debounceTimers.delete(key);
      refreshDiagnostics(document);
      codeLensProvider.refresh();
    };
    if (immediate) {
      run();
    } else {
      debounceTimers.set(key, setTimeout(run, CHANGE_DEBOUNCE_MS));
    }
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => scheduleRefresh(doc, true)),
    vscode.workspace.onDidSaveTextDocument((doc) => scheduleRefresh(doc, true)),
    vscode.workspace.onDidChangeTextDocument((event) =>
      scheduleRefresh(event.document, false),
    ),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (isPackageJson(doc)) {
        diagnostics.clear(doc.uri);
        analysisCache.invalidate(doc.uri);
      }
      const timer = debounceTimers.get(doc.uri.toString());
      if (timer) {
        clearTimeout(timer);
        debounceTimers.delete(doc.uri.toString());
      }
    }),
    new vscode.Disposable(() => {
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
    }),
  );

  // Analyze whatever package.json files are already open at activation.
  for (const document of vscode.workspace.textDocuments) {
    scheduleRefresh(document, true);
  }
}

export function deactivate(): void {
  // All resources are registered as subscriptions and disposed by VS Code.
}
