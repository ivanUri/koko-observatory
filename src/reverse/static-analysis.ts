import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

const traverse = (traverseModule as unknown as { default?: typeof traverseModule }).default ?? traverseModule;

type BabelNode = {
  type?: string;
  id?: { name?: unknown };
  key?: { name?: unknown };
  start?: number;
  end?: number;
  loc?: { start?: { line?: number; column?: number } };
  callee?: BabelNode;
  object?: BabelNode;
  property?: BabelNode;
  computed?: boolean;
  source?: { value?: unknown };
  declaration?: { id?: { name?: unknown } };
  specifiers?: Array<{ exported?: { name?: unknown } }>;
};
type BabelPath = { node: BabelNode };

export interface StaticFunctionIndex {
  name: string;
  kind: "declaration" | "expression" | "arrow" | "method";
  start: number;
  end: number;
  line: number;
  column: number;
}

export interface StaticScriptIndex {
  sourceUrl?: string;
  functions: StaticFunctionIndex[];
  calls: Array<{ callee: string; line: number; column: number }>;
  imports: string[];
  exports: string[];
  parseError?: string;
}

export function indexJavaScript(source: string, sourceUrl?: string): StaticScriptIndex {
  const result: StaticScriptIndex = { sourceUrl, functions: [], calls: [], imports: [], exports: [] };
  try {
    const ast = parse(source, { sourceType: "unambiguous", errorRecovery: true, plugins: ["jsx", "typescript", "classProperties", "dynamicImport", "topLevelAwait"] });
    traverse(ast, {
      FunctionDeclaration(path: BabelPath) { addFunction(result, path.node, "declaration", String(path.node.id?.name ?? "anonymous")); },
      FunctionExpression(path: BabelPath) { addFunction(result, path.node, "expression", String(path.node.id?.name ?? "anonymous")); },
      ArrowFunctionExpression(path: BabelPath) { addFunction(result, path.node, "arrow", "arrow"); },
      ObjectMethod(path: BabelPath) { addFunction(result, path.node, "method", String(path.node.key?.name ?? "method")); },
      CallExpression(path: BabelPath) { result.calls.push({ callee: calleeName(path.node.callee), line: path.node.loc?.start.line ?? 0, column: path.node.loc?.start.column ?? 0 }); },
      ImportDeclaration(path: BabelPath) { if (typeof path.node.source?.value === "string") result.imports.push(path.node.source.value); },
      ExportNamedDeclaration(path: BabelPath) { if (path.node.declaration?.id?.name) result.exports.push(String(path.node.declaration.id.name)); for (const specifier of path.node.specifiers ?? []) if (specifier.exported?.name) result.exports.push(String(specifier.exported.name)); },
      ExportDefaultDeclaration() { result.exports.push("default"); },
    });
  } catch (error) {
    result.parseError = error instanceof Error ? error.message : String(error);
  }
  return result;
}

export function mapSourcePosition(sourceMap: string | object, line: number, column: number) {
  try {
    const map = new TraceMap(typeof sourceMap === "string" ? JSON.parse(sourceMap) : sourceMap);
    return originalPositionFor(map, { line, column });
  } catch {
    return { source: null, line: null, column: null, name: null };
  }
}

function addFunction(result: StaticScriptIndex, node: BabelNode, kind: StaticFunctionIndex["kind"], name: string) {
  result.functions.push({ name, kind, start: node.start ?? 0, end: node.end ?? 0, line: node.loc?.start.line ?? 0, column: node.loc?.start.column ?? 0 });
}

function calleeName(node: BabelNode | undefined): string {
  if (!node) return "unknown";
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") return `${calleeName(node.object)}.${node.computed ? "[…]" : calleeName(node.property)}`;
  return node.type;
}
