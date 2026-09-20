import assert from "node:assert/strict";
import ts from "typescript";

const NETWORK_MODULE = /^(?:node:)?(?:http|https|http2|net|tls|dns|dgram)(?:\/|$)/u;

export function assertStaticModulePolicy(source, label = "source.ts") {
  const parsed = ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true);
  const specifiers = [];
  function inspectSpecifier(node) {
    assert.ok(node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)), `${label}: runtime imports must name a static module`);
    const specifier = node.text;
    assert.doesNotMatch(specifier, NETWORK_MODULE, `${label}: network built-in import is forbidden`);
    assert.ok(specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../"), `${label}: runtime third-party import is forbidden`);
    specifiers.push(specifier);
  }
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) inspectSpecifier(node.moduleSpecifier);
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        inspectSpecifier(node.arguments[0]);
      }
      const called = node.expression;
      assert.ok(!(ts.isIdentifier(called) && called.text === "fetch") && !(ts.isPropertyAccessExpression(called) && called.name.text === "fetch"), `${label}: runtime fetch is forbidden`);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return specifiers;
}
