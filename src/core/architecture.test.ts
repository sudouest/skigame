import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(__dirname, '..');
const DOM_GLOBALS = new Set([
  'window',
  'document',
  'HTMLElement',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]);
const SINGLETON_METHOD = `${'get'}${'Instance'}`;

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      out.push(full);
    }
  }
  return out;
}

function getLayerName(filePath: string): string | null {
  const rel = path.relative(SRC_ROOT, filePath).split(path.sep);
  return rel[0] ?? null;
}

function extractModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      if (ts.isStringLiteral(node.argument.literal)) {
        specs.push(node.argument.literal.text);
      }
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) {
        if (
          node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require')
        ) {
          specs.push(arg.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specs;
}

function resolveImportLayer(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  return getLayerName(resolved);
}

const GLOBAL_HOLDERS = new Set(['globalThis', 'self', 'window']);

function findDomGlobalReferences(sourceFile: ts.SourceFile): string[] {
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && DOM_GLOBALS.has(node.text)) {
      const parent = node.parent;
      const isPropertyAccess = ts.isPropertyAccessExpression(parent) && parent.name === node;
      if (isPropertyAccess) {
        if (ts.isIdentifier(parent.expression) && GLOBAL_HOLDERS.has(parent.expression.text)) {
          hits.push(`${parent.expression.text}.${node.text}`);
        }
      } else {
        const isSafeMemberKey =
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isPropertySignature(parent) && parent.name === node) ||
          (ts.isPropertyDeclaration(parent) && parent.name === node) ||
          (ts.isMethodDeclaration(parent) && parent.name === node) ||
          (ts.isMethodSignature(parent) && parent.name === node);
        if (!isSafeMemberKey) {
          hits.push(node.text);
        }
      }
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_HOLDERS.has(node.expression.text) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      DOM_GLOBALS.has(node.argumentExpression.text)
    ) {
      hits.push(`${node.expression.text}['${node.argumentExpression.text}']`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

function definesSingletonMethod(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      (ts.isMethodDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertyAssignment(node) ||
        ts.isVariableDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === SINGLETON_METHOD
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe('architectural boundaries', () => {
  const allFiles = collectTsFiles(SRC_ROOT);
  const parsedFiles = allFiles.map((filePath) => {
    const text = fs.readFileSync(filePath, 'utf8');
    return {
      filePath,
      relPath: path.relative(SRC_ROOT, filePath),
      layer: getLayerName(filePath),
      sourceFile: ts.createSourceFile(filePath, text, ts.ScriptTarget.ES2022, true),
    };
  });

  it('prevents src/core/ from importing three or game layers (sim, render, ui, content, tools)', () => {
    const forbiddenLayers = new Set(['sim', 'render', 'ui', 'content', 'tools']);
    const violations: string[] = [];

    for (const file of parsedFiles) {
      if (file.layer !== 'core') continue;
      for (const spec of extractModuleSpecifiers(file.sourceFile)) {
        if (spec === 'three' || spec.startsWith('three/')) {
          violations.push(`${file.relPath} imports '${spec}'`);
        }
        const targetLayer = resolveImportLayer(file.filePath, spec);
        if (targetLayer && forbiddenLayers.has(targetLayer)) {
          violations.push(`${file.relPath} imports '${spec}' (layer '${targetLayer}')`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('prevents src/content/ from importing three, DOM globals, or runtime layers (sim, render, ui, tools)', () => {
    const forbiddenLayers = new Set(['sim', 'render', 'ui', 'tools']);
    const violations: string[] = [];

    for (const file of parsedFiles) {
      if (file.layer !== 'content') continue;
      for (const spec of extractModuleSpecifiers(file.sourceFile)) {
        if (spec === 'three' || spec.startsWith('three/')) {
          violations.push(`${file.relPath} imports '${spec}'`);
        }
        const targetLayer = resolveImportLayer(file.filePath, spec);
        if (targetLayer && forbiddenLayers.has(targetLayer)) {
          violations.push(`${file.relPath} imports '${spec}' (layer '${targetLayer}')`);
        }
      }
      for (const domId of findDomGlobalReferences(file.sourceFile)) {
        violations.push(`${file.relPath} references DOM global '${domId}'`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('prevents src/sim/ from importing three, render, ui, tools, or referencing DOM globals', () => {
    const forbiddenLayers = new Set(['render', 'ui', 'tools']);
    const violations: string[] = [];

    for (const file of parsedFiles) {
      if (file.layer !== 'sim') continue;
      for (const spec of extractModuleSpecifiers(file.sourceFile)) {
        if (spec === 'three' || spec.startsWith('three/')) {
          violations.push(`${file.relPath} imports '${spec}'`);
        }
        const targetLayer = resolveImportLayer(file.filePath, spec);
        if (targetLayer && forbiddenLayers.has(targetLayer)) {
          violations.push(`${file.relPath} imports '${spec}' (layer '${targetLayer}')`);
        }
      }
      for (const domId of findDomGlobalReferences(file.sourceFile)) {
        violations.push(`${file.relPath} references DOM global '${domId}'`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('forbids getInstance() singletons anywhere in src/', () => {
    const violations: string[] = [];
    for (const file of parsedFiles) {
      if (definesSingletonMethod(file.sourceFile)) {
        violations.push(file.relPath);
      }
    }
    expect(violations).toEqual([]);
  });

  it('flags indirect DOM global access via globalThis/self while allowing non-global member names', () => {
    const sample = ts.createSourceFile(
      'sample.ts',
      [
        'const a = globalThis.window;',
        'const b = self.document;',
        "const c = globalThis['requestAnimationFrame'];",
        'const ok = { window: 1 };',
        'const ok2 = ok.window;',
      ].join('\n'),
      ts.ScriptTarget.ES2022,
      true,
    );
    expect(findDomGlobalReferences(sample)).toEqual([
      'globalThis.window',
      'self.document',
      "globalThis['requestAnimationFrame']",
    ]);
  });
});
