import * as vscode from "vscode";
import { parseTree, Node } from "jsonc-parser";
import { RegistryClient } from "./registry";
import { isOutdated, describeRange } from "./semverUtil";

/** The dependency categories we manage, in a stable display order. */
export const DEPENDENCY_CATEGORIES = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

export interface PackageInfo {
  name: string;
  category: string;
  /** The raw version spec as written in the file, e.g. "^1.2.3". */
  range: string;
  /** Latest published version, or null if it couldn't be resolved. */
  latest: string | null;
  /** True when `latest` is a real upgrade over `range`. */
  outdated: boolean;
  /** Whether the version spec is comparable at all (skips git/file/workspace). */
  comparable: boolean;
  /** Range covering the whole "name": "version" line for diagnostics. */
  lineRange: vscode.Range;
  /** Range of just the version string value (quotes excluded) for edits. */
  valueRange: vscode.Range;
}

export interface CategoryInfo {
  name: string;
  /** Range of the category key, e.g. the `"dependencies"` token. */
  keyRange: vscode.Range;
  packages: PackageInfo[];
}

export interface DocumentAnalysis {
  categories: CategoryInfo[];
}

/** True if the document is a file we should manage (named package.json). */
export function isPackageJson(document: vscode.TextDocument): boolean {
  return /(^|[\\/])package\.json$/i.test(document.fileName);
}

function rangeFromNode(
  document: vscode.TextDocument,
  node: Node,
): vscode.Range {
  return new vscode.Range(
    document.positionAt(node.offset),
    document.positionAt(node.offset + node.length),
  );
}

/** Range of a string node's contents, excluding the surrounding quotes. */
function stringContentRange(
  document: vscode.TextDocument,
  node: Node,
): vscode.Range {
  return new vscode.Range(
    document.positionAt(node.offset + 1),
    document.positionAt(node.offset + node.length - 1),
  );
}

function findProperty(objectNode: Node, key: string): Node | undefined {
  if (objectNode.type !== "object" || !objectNode.children) {
    return undefined;
  }
  return objectNode.children.find(
    (prop) => prop.type === "property" && prop.children?.[0]?.value === key,
  );
}

/**
 * Parse a package.json document and resolve the latest version for every
 * dependency, returning the structure both the code-lens provider and the
 * diagnostics use.
 */
export async function analyzeDocument(
  document: vscode.TextDocument,
  registry: RegistryClient,
): Promise<DocumentAnalysis> {
  const tree = parseTree(document.getText());
  const categories: CategoryInfo[] = [];

  if (!tree || tree.type !== "object") {
    return { categories };
  }

  // First pass: gather the structural info synchronously from the parse tree.
  type RawPackage = {
    name: string;
    range: string;
    lineRange: vscode.Range;
    valueRange: vscode.Range;
  };
  const raw: Array<{
    name: string;
    keyRange: vscode.Range;
    packages: RawPackage[];
  }> = [];

  for (const category of DEPENDENCY_CATEGORIES) {
    const categoryProp = findProperty(tree, category);
    const keyNode = categoryProp?.children?.[0];
    const valueNode = categoryProp?.children?.[1];
    if (
      !categoryProp ||
      !keyNode ||
      !valueNode ||
      valueNode.type !== "object"
    ) {
      continue;
    }

    const packages: RawPackage[] = [];
    for (const prop of valueNode.children ?? []) {
      if (prop.type !== "property") {
        continue;
      }
      const pkgKey = prop.children?.[0];
      const pkgValue = prop.children?.[1];
      if (!pkgKey || !pkgValue || typeof pkgKey.value !== "string") {
        continue;
      }
      const range = typeof pkgValue.value === "string" ? pkgValue.value : "";
      const lineRange = new vscode.Range(
        rangeFromNode(document, pkgKey).start,
        rangeFromNode(document, pkgValue).end,
      );
      const valueRange =
        pkgValue.type === "string"
          ? stringContentRange(document, pkgValue)
          : rangeFromNode(document, pkgValue);
      packages.push({ name: pkgKey.value, range, lineRange, valueRange });
    }

    raw.push({
      name: category,
      keyRange: rangeFromNode(document, keyNode),
      packages,
    });
  }

  // Second pass: resolve latest versions in parallel (cached by the client).
  const allNames = new Set<string>();
  for (const cat of raw) {
    for (const pkg of cat.packages) {
      allNames.add(pkg.name);
    }
  }
  const latestByName = new Map<string, string | null>();
  await Promise.all(
    [...allNames].map(async (name) => {
      latestByName.set(name, await registry.getLatestVersion(name));
    }),
  );

  for (const cat of raw) {
    const packages: PackageInfo[] = cat.packages.map((pkg) => {
      const latest = latestByName.get(pkg.name) ?? null;
      const outdated = latest !== null && isOutdated(pkg.range, latest);
      const comparable = latest !== null && describeRange(pkg.range).comparable;
      return {
        name: pkg.name,
        category: cat.name,
        range: pkg.range,
        latest,
        outdated,
        comparable,
        lineRange: pkg.lineRange,
        valueRange: pkg.valueRange,
      };
    });
    categories.push({ name: cat.name, keyRange: cat.keyRange, packages });
  }

  return { categories };
}
