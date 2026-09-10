import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE_FILES = [
  "src/index.ts", "src/bot.ts", "src/bot-inbox.ts", "src/status-board-store.ts",
] as const;

interface BoundaryOptions { readonly allowUnresolvedFormatter?: boolean; }
type TaintKey = ts.Symbol | string;

function telegramLogBoundaryViolations(fileName: string, source: string, options: BoundaryOptions = {}): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const program = ts.createProgram({
    rootNames: [fileName],
    options: { noLib: true, noResolve: true },
    host: sourceCompilerHost(fileName, sourceFile),
  });
  const checker = program.getTypeChecker();
  const violations = new Set<string>();

  const report = (node: ts.Node): void => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    violations.add(`${fileName}:${line}`);
  };

  interface CatchScope { readonly taintedSymbols: ReadonlySet<TaintKey>; readonly functionDepth: number; }

  const visit = (node: ts.Node, catchScopes: readonly CatchScope[], functionDepth: number): void => {
    if (isFormatErrorDefinition(node) || isFormatErrorCall(node)) report(node);

    if (ts.isCallExpression(node) && isGlobalConsoleWarningOrError(node, checker)) {
      const referencedCatchScopes = catchScopes.filter(({ taintedSymbols }) =>
        referencesAnySymbol(node, taintedSymbols, checker)
      );
      const directCatchScope = catchScopes.at(-1);
      if (
        referencedCatchScopes.some(({ taintedSymbols }) =>
          !isSafeFormattedLogCall(node, taintedSymbols, checker, options.allowUnresolvedFormatter === true)
        )
        || (
          directCatchScope?.functionDepth === functionDepth
          && referencedCatchScopes.length === 0
          && isDirectApprovedFormatterCall(node, checker, options.allowUnresolvedFormatter === true)
        )
      ) {
        report(node);
      }
    }

    let descendantCatchScopes = catchScopes;
    if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
      const taintedSymbols = new Set<TaintKey>();
      addBindingSymbols(node.variableDeclaration.name, taintedSymbols, checker);
      propagateCatchTaint(node.block, taintedSymbols, checker);
      if (taintedSymbols.size > 0) {
        descendantCatchScopes = [...catchScopes, { taintedSymbols, functionDepth }];
      }
    }
    const descendantFunctionDepth = isFunctionBoundary(node) ? functionDepth + 1 : functionDepth;
    ts.forEachChild(node, (child) =>
      visit(child, descendantCatchScopes, descendantFunctionDepth)
    );
  };

  visit(sourceFile, [], 0);
  return [...violations];
}

function sourceCompilerHost(fileName: string, sourceFile: ts.SourceFile): ts.CompilerHost {
  return {
    fileExists: (candidate) => candidate === fileName,
    getCanonicalFileName: (candidate) => candidate,
    getCurrentDirectory: () => "",
    getDefaultLibFileName: () => "lib.d.ts",
    getNewLine: () => "\n",
    getSourceFile: (candidate) => candidate === fileName ? sourceFile : undefined,
    readFile: (candidate) => candidate === fileName ? sourceFile.text : undefined,
    useCaseSensitiveFileNames: () => true,
    writeFile: () => undefined,
  };
}

function isGlobalConsoleWarningOrError(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const member = staticMemberAccess(call.expression);
  return member !== undefined
    && (member.name === "warn" || member.name === "error")
    && isGlobalConsole(member.receiver, checker);
}

function isGlobalConsole(node: ts.Expression, checker: ts.TypeChecker): boolean {
  if (isUnboundGlobalIdentifier(node, "console", checker)) return true;
  const member = staticMemberAccess(node);
  return member !== undefined
    && member.name === "console"
    && isUnboundGlobalIdentifier(member.receiver, "globalThis", checker);
}

function isUnboundGlobalIdentifier(
  node: ts.Expression,
  name: "console" | "globalThis",
  checker: ts.TypeChecker,
): boolean {
  const expression = unwrapExpression(node);
  const symbol = ts.isIdentifier(expression) ? checker.getSymbolAtLocation(expression) : undefined;
  return ts.isIdentifier(expression)
    && expression.text === name
    && (symbol === undefined || symbol.declarations?.length === 0);
}

function isFunctionBoundary(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node);
}

function staticMemberAccess(
  node: ts.Expression,
): { readonly receiver: ts.Expression; readonly name: string } | undefined {
  const expression = unwrapExpression(node);
  if (ts.isPropertyAccessExpression(expression)) {
    return { receiver: expression.expression, name: expression.name.text };
  }
  if (ts.isElementAccessExpression(expression)) {
    const name = staticString(expression.argumentExpression);
    return name === undefined ? undefined : { receiver: expression.expression, name };
  }
  return undefined;
}

function staticString(node: ts.Expression): string | undefined {
  const expression = unwrapExpression(node);
  return ts.isStringLiteralLike(expression) ? expression.text : undefined;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let expression = node;
  while (
    ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isSatisfiesExpression(expression)
  ) expression = expression.expression;
  return expression;
}

function referencesAnySymbol(
  node: ts.Node,
  expected: ReadonlySet<TaintKey>,
  checker: ts.TypeChecker,
): boolean {
  let found = false;
  const visit = (descendant: ts.Node): void => {
    if (found) return;
    const symbol = ts.isIdentifier(descendant) ? checker.getSymbolAtLocation(descendant) : undefined;
    const member = ts.isPropertyAccessExpression(descendant) || ts.isElementAccessExpression(descendant)
      ? memberTaintKey(descendant)
      : undefined;
    if ((symbol !== undefined && expected.has(symbol))
      || (member !== undefined && (expected.has(member) || expected.has("member:*")))) {
      found = true;
      return;
    }
    ts.forEachChild(descendant, visit);
  };
  visit(node);
  return found;
}

function addBindingSymbols(
  name: ts.BindingName,
  output: Set<TaintKey>,
  checker: ts.TypeChecker,
): void {
  if (ts.isIdentifier(name)) {
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol !== undefined) output.add(symbol);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) addBindingSymbols(element.name, output, checker);
  }
}

function propagateCatchTaint(
  block: ts.Block,
  tainted: Set<TaintKey>,
  checker: ts.TypeChecker,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    const addTarget = (target: ts.Node): void => {
      const before = tainted.size;
      if (ts.isVariableDeclaration(target) || ts.isParameter(target)) {
        addBindingSymbols(target.name, tainted, checker);
      } else if (ts.isFunctionDeclaration(target) && target.name !== undefined) {
        addAssignmentSymbols(target.name, tainted, checker);
      } else {
        addAssignmentSymbols(target as ts.Expression, tainted, checker);
      }
      if (tainted.size !== before) changed = true;
    };
    const visit = (node: ts.Node): void => {
      if (
        (ts.isVariableDeclaration(node) || ts.isParameter(node))
        && node.initializer !== undefined
        && referencesAnySymbol(node.initializer, tainted, checker)
      ) addTarget(node);
      if (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && referencesAnySymbol(node.right, tainted, checker)
      ) addTarget(node.left);
      if (
        ts.isFunctionDeclaration(node)
        && node.body !== undefined
        && referencesAnySymbol(node.body, tainted, checker)
      ) addTarget(node);
      ts.forEachChild(node, visit);
    };
    visit(block);
  }
}

function addAssignmentSymbols(
  target: ts.Expression,
  output: Set<TaintKey>,
  checker: ts.TypeChecker,
): void {
  const node = unwrapExpression(target);
  if (ts.isIdentifier(node)) {
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol !== undefined) output.add(symbol);
  } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    output.add(memberTaintKey(node));
  } else if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) addAssignmentSymbols(element, output, checker);
  } else if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        addAssignmentSymbols(property.name, output, checker);
      } else if (ts.isPropertyAssignment(property)) {
        addAssignmentSymbols(property.initializer, output, checker);
      } else if (ts.isSpreadAssignment(property)) {
        addAssignmentSymbols(property.expression, output, checker);
      }
    }
  }
}

function memberTaintKey(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string {
  const name = ts.isPropertyAccessExpression(node) ? node.name.text : staticString(node.argumentExpression);
  return name === undefined ? "member:*" : `member:${name}`;
}

function isSafeFormattedLogCall(
  call: ts.CallExpression,
  taintedSymbols: ReadonlySet<TaintKey>,
  checker: ts.TypeChecker,
  allowUnresolvedFormatter: boolean,
): boolean {
  if (call.arguments.length !== 1) return false;
  const formatterCall = unwrapExpression(call.arguments[0]);
  if (
    !ts.isCallExpression(formatterCall)
    || !isApprovedFormatterReference(
      formatterCall.expression,
      checker,
      allowUnresolvedFormatter,
    )
    || formatterCall.arguments.length !== 2
  ) {
    return false;
  }
  return !referencesAnySymbol(formatterCall.arguments[0], taintedSymbols, checker)
    && referencesAnySymbol(formatterCall.arguments[1], taintedSymbols, checker);
}

function isDirectApprovedFormatterCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  allowUnresolvedFormatter: boolean,
): boolean {
  if (call.arguments.length !== 1) return false;
  const formatterCall = unwrapExpression(call.arguments[0]);
  return ts.isCallExpression(formatterCall)
    && isApprovedFormatterReference(
      formatterCall.expression,
      checker,
      allowUnresolvedFormatter,
    );
}

function isApprovedFormatterReference(
  node: ts.LeftHandSideExpression,
  checker: ts.TypeChecker,
  allowUnresolvedFormatter: boolean,
): boolean {
  const expression = unwrapExpression(node);
  if (!ts.isIdentifier(expression) || expression.text !== "formatTelegramErrorLog") return false;
  const symbol = checker.getSymbolAtLocation(expression);
  if (symbol === undefined) return allowUnresolvedFormatter;
  return symbol?.declarations?.some((declaration) => {
    if (!ts.isImportSpecifier(declaration) || declaration.isTypeOnly) return false;
    const importedName = declaration.propertyName?.text ?? declaration.name.text;
    const importDeclaration = declaration.parent.parent.parent;
    return declaration.name.text === "formatTelegramErrorLog"
      && importedName === "formatTelegramErrorLog"
      && ts.isImportDeclaration(importDeclaration)
      && !importDeclaration.importClause?.isTypeOnly
      && ts.isStringLiteral(importDeclaration.moduleSpecifier)
      && importDeclaration.moduleSpecifier.text === "./telegram-error-log.js";
  }) === true;
}

function isFormatErrorDefinition(node: ts.Node): boolean {
  if (
    !ts.isFunctionDeclaration(node)
    && !ts.isFunctionExpression(node)
    && !ts.isMethodDeclaration(node)
    && !ts.isVariableDeclaration(node)
    && !ts.isPropertyDeclaration(node)
    && !ts.isPropertyAssignment(node)
    && !ts.isGetAccessorDeclaration(node)
    && !ts.isSetAccessorDeclaration(node)
    && !ts.isParameter(node)
    && !ts.isBindingElement(node)
    && !ts.isImportSpecifier(node)
  ) {
    return false;
  }
  if (node.name !== undefined && staticDeclarationName(node.name) === "formatError") return true;
  return (ts.isImportSpecifier(node) || ts.isBindingElement(node))
    && node.propertyName !== undefined
    && staticDeclarationName(node.propertyName) === "formatError";
}

function staticDeclarationName(name: ts.DeclarationName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return staticString(name.expression);
  return undefined;
}

function isFormatErrorCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const expression = unwrapExpression(node.expression);
  if (ts.isIdentifier(expression)) return expression.text === "formatError";
  return staticMemberAccess(expression)?.name === "formatError";
}

const FORMATTER_IMPORT = 'import { formatTelegramErrorLog } from "./telegram-error-log.js";';
const caught = (body: string, binding = "error"): string =>
  `try {\n  await work();\n} catch (${binding}) {\n  ${body.replaceAll("\n", "\n  ")}\n}`;
const expectFixture = (source: string, lines: readonly number[]): void => {
  expect(telegramLogBoundaryViolations("fixture.ts", source))
    .toEqual(lines.map((line) => `fixture.ts:${line}`));
};

describe("Telegram log boundary guard", () => {
  it("reports only the unsafe boundary location", () => {
    expectFixture(caught('console.error("failed", error);'), [4]);
  });

  it("accepts the plan's exact no-import safe fixture only with explicit fixture mode", () => {
    const source = caught('console.error(formatTelegramErrorLog("bot_handler", error));');
    expect(telegramLogBoundaryViolations("fixture.ts", source, {
      allowUnresolvedFormatter: true,
    })).toEqual([]);
  });

  it("rejects the plan's no-import safe fixture by default", () => {
    expectFixture(caught('console.error(formatTelegramErrorLog("bot_handler", error));'), [4]);
  });

  it("accepts the imported structured formatter by default", () => {
    expectFixture(`${FORMATTER_IMPORT}\n${caught('console.error(formatTelegramErrorLog("bot_handler", error));')}`, []);
  });

  it.each([
    ["extra console argument", 'console.warn(formatTelegramErrorLog("bot_handler", error), error);'],
    ["extra formatter argument", 'console.error(formatTelegramErrorLog("bot_handler", error, "extra"));'],
    ["catch-derived operation", "console.error(formatTelegramErrorLog(String(error), error));"],
    ["unrelated error argument", 'console.error(formatTelegramErrorLog("bot_handler", new Error("other")));'],
  ])("rejects %s", (_name, statement) => {
    expectFixture(`${FORMATTER_IMPORT}\n${caught(statement)}`, [5]);
  });

  it("rejects a local formatter with the approved name", () => {
    const local = "function formatTelegramErrorLog(operation: string, error: unknown) { return operation; }";
    const source = `${local}\n${caught('console.error(formatTelegramErrorLog("bot_handler", error));')}`;
    expect(telegramLogBoundaryViolations("fixture.ts", source, {
      allowUnresolvedFormatter: true,
    })).toEqual(["fixture.ts:5"]);
  });

  it("rejects a parameter shadowing the imported formatter", () => {
    const source = `${FORMATTER_IMPORT}\nasync function run(formatTelegramErrorLog: (operation: string, error: unknown) => string) {
  ${caught('console.error(formatTelegramErrorLog("bot_handler", error));').replaceAll("\n", "\n  ")}
}`;
    expectFixture(source, [6]);
  });

  it("recognizes global and computed console boundaries", () => {
    expectFixture(caught('console["warn"](error);\nglobalThis.console.error(error);\nglobalThis["console"]["warn"](error);'), [4, 5, 6]);
  });

  it("ignores a locally shadowed console", () => {
    const local = "const console = { error: (value: unknown) => value };";
    expectFixture(`${local}\n${caught("console.error(error);")}`, []);
  });

  it.each([
    ["direct", "function formatError(value: unknown) { return String(value); }", "formatError(error)"],
    ["computed", 'const helper = { ["formatError"](value: unknown) { return String(value); } };', 'helper["formatError"](error)'],
    ["property", "const helper = { formatError(value: unknown) { return String(value); } };", "helper.formatError(error)"],
  ])("rejects %s formatError definitions and calls", (_name, definition, call) => {
    expectFixture(`${definition}\n${caught(`console.error(${call});`)}`, [1, 5]);
  });

  it.each([
    ["parentheses", "(console.error)(error)"],
    ["as", "(console.error as typeof console.error)(error)"],
    ["type assertion", "(<typeof console.error>console.error)(error)"],
    ["non-null", "console.error!(error)"],
    ["satisfies", "(console.error satisfies typeof console.error)(error)"],
    ["receiver parentheses", "(console).error(error)"],
    ["globalThis as", "(globalThis as typeof globalThis).console.error(error)"],
  ])("unwraps %s around global console", (_name, statement) => {
    expectFixture(caught(`${statement};`), [4]);
  });

  it.each([
    ["parentheses", '(formatTelegramErrorLog("bot_handler", error))'],
    ["as", '(formatTelegramErrorLog as typeof formatTelegramErrorLog)("bot_handler", error)'],
    ["type assertion", '(<typeof formatTelegramErrorLog>formatTelegramErrorLog)("bot_handler", error)'],
    ["non-null", 'formatTelegramErrorLog!("bot_handler", error)'],
    ["satisfies", '(formatTelegramErrorLog satisfies typeof formatTelegramErrorLog)("bot_handler", error)'],
  ])("unwraps %s around the formatter", (_name, formatted) => {
    expectFixture(`${FORMATTER_IMPORT}\n${caught(`console.error(${formatted});`)}`, []);
  });

  it.each([
    ["catch binding", "try { await work(); } catch ({ error }) {\n  console.error(error);\n}", 2],
    ["constant alias", "try { await work(); } catch (error) {\n  const alias = error;\n  console.error(alias);\n}", 3],
    ["destructured alias", "try { await work(); } catch (error) {\n  const { message } = error;\n  console.error(message);\n}", 3],
    ["assigned alias", "let alias;\ntry { await work(); } catch (error) {\n  alias = error;\n  console.error(alias);\n}", 4],
    ["destructuring assignment", "let alias;\ntry { await work(); } catch (error) {\n  ({ message: alias } = error);\n  console.error(alias);\n}", 4],
    ["member assignment", "const holder = { value: undefined };\ntry { await work(); } catch (error) {\n  holder.value = error;\n  console.error(holder.value);\n}", 4],
    ["element assignment", "const holder = { value: undefined };\ntry { await work(); } catch (error) {\n  holder[\"value\"] = error;\n  console.error(holder[\"value\"]);\n}", 4],
    ["default parameter", "try { await work(); } catch (error) {\n  function report(alias = error) { console.error(alias); }\n  report();\n}", 2],
    ["function return", "try { await work(); } catch (error) {\n  function reveal() { return error; }\n  console.error(reveal());\n}", 3],
    ["compound assignment", "let alias;\ntry { await work(); } catch (error) {\n  alias ||= error;\n  console.error(alias);\n}", 4],
    ["this member", "class Store {\n  lastError: unknown;\n  async run() {\n    try { await work(); } catch (error) {\n      this.lastError = error;\n      console.error(this.lastError);\n    }\n  }\n}", 6],
    ["call-result member", "declare function state(): { lastError: unknown };\ntry { await work(); } catch (error) {\n  state().lastError = error;\n  console.error(state().lastError);\n}", 4],
    ["dot to literal element", "const holder = { value: undefined };\ntry { await work(); } catch (error) {\n  holder.value = error;\n  console.error(holder[\"value\"]);\n}", 4],
    ["literal element to dot", "const holder = { value: undefined };\ntry { await work(); } catch (error) {\n  holder[\"value\"] = error;\n  console.error(holder.value);\n}", 4],
    ["dynamic member", "declare const key: string; const holder: Record<string, unknown> = {};\ntry { await work(); } catch (error) {\n  holder[key] = error;\n  console.error(holder.other);\n}", 4],
  ])("tracks a catch-derived %s", (_name, source, line) => expectFixture(source, [line]));

  it.each([
    ['import { formatError as safe } from "./legacy.js";'],
    ["const { formatError: safe } = helper;"],
    ['const { ["formatError"]: safe } = helper;'],
  ])("rejects an aliased formatError declaration", (source) => expectFixture(source, [1]));

  it("keeps all production catch boundaries safe", () => {
    const violations = SOURCE_FILES.flatMap((fileName) => telegramLogBoundaryViolations(
      fileName,
      readFileSync(new URL(`../${fileName}`, import.meta.url), "utf8"),
    ));
    expect(violations).toEqual([]);
  });
});
