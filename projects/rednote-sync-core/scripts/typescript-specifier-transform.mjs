import assert from "node:assert/strict";

const MAX_TEMPLATE_DEPTH = 64;

function identifierStart(character) {
  return character !== undefined && /[A-Za-z_$]/u.test(character);
}

function identifierPart(character) {
  return character !== undefined && /[A-Za-z0-9_$]/u.test(character);
}

function regexCanStart(previous) {
  if (previous === undefined) return true;
  if (previous.kind === "string" || previous.kind === "number" || previous.kind === "template" || previous.kind === "regex") return false;
  if (previous.kind === "identifier") return /^(?:await|case|delete|do|else|in|instanceof|new|of|return|throw|typeof|void|yield)$/u.test(previous.value);
  return ![")", "]", "}"].includes(previous.value);
}

function scanQuoted(source, start) {
  const quote = source[start];
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      escaped = true;
      assert.notEqual(index + 1, source.length, "unterminated string escape in dist transform");
      index += 1;
      continue;
    }
    assert.notEqual(character, "\n", "unterminated string literal in dist transform");
    assert.notEqual(character, "\r", "unterminated string literal in dist transform");
    if (character === quote) return { end: index + 1, escaped };
  }
  assert.fail("unterminated string literal in dist transform");
}

function scanRegex(source, start) {
  let inClass = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      assert.notEqual(index + 1, source.length, "unterminated regular expression escape in dist transform");
      index += 1;
      continue;
    }
    if (character === "[") { inClass = true; continue; }
    if (character === "]") { inClass = false; continue; }
    assert.notEqual(character, "\n", "unterminated regular expression in dist transform");
    assert.notEqual(character, "\r", "unterminated regular expression in dist transform");
    if (character === "/" && !inClass) {
      let end = index + 1;
      while (/[A-Za-z]/u.test(source[end] ?? "")) end += 1;
      return end;
    }
  }
  assert.fail("unterminated regular expression in dist transform");
}

function scanTemplate(source, start, depth) {
  assert.equal(depth <= MAX_TEMPLATE_DEPTH, true, "template nesting exceeds dist transform limit");
  const expressionTokens = [];
  for (let index = start + 1; index < source.length;) {
    if (source[index] === "\\") {
      assert.notEqual(index + 1, source.length, "unterminated template escape in dist transform");
      index += 2;
      continue;
    }
    if (source[index] === "`") return { end: index + 1, expressionTokens };
    if (source[index] === "$" && source[index + 1] === "{") {
      const expression = scanCode(source, index + 2, true, depth);
      expressionTokens.push(...expression.tokens);
      index = expression.end;
      continue;
    }
    index += 1;
  }
  assert.fail("unterminated template literal in dist transform");
}

function scanCode(source, start, stopAtTemplateBrace, depth) {
  const tokens = [];
  let braceDepth = 0;
  let index = start;
  let pendingComment = false;
  let previous;
  const add = (token) => {
    const completed = Object.freeze({ ...token, leadingComment: pendingComment });
    tokens.push(completed);
    pendingComment = false;
    previous = completed;
  };

  while (index < source.length) {
    const character = source[index];
    if (/\s/u.test(character)) { index += 1; continue; }
    if (character === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index + 2);
      index = newline === -1 ? source.length : newline + 1;
      pendingComment = true;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      assert.notEqual(close, -1, "unterminated block comment in dist transform");
      index = close + 2;
      pendingComment = true;
      continue;
    }
    if (character === "'" || character === '"') {
      const scanned = scanQuoted(source, index);
      add({ kind: "string", value: source.slice(index + 1, scanned.end - 1), start: index, end: scanned.end, quote: character, escaped: scanned.escaped });
      index = scanned.end;
      continue;
    }
    if (character === "`") {
      const scanned = scanTemplate(source, index, depth + 1);
      add({ kind: "template", value: source.slice(index, scanned.end), start: index, end: scanned.end });
      tokens.push(...scanned.expressionTokens);
      index = scanned.end;
      continue;
    }
    if (character === "/" && stopAtTemplateBrace) {
      assert.fail("template expression slash syntax is unsupported in dist transform");
    }
    if (character === "/" && regexCanStart(previous)) {
      const end = scanRegex(source, index);
      add({ kind: "regex", value: source.slice(index, end), start: index, end });
      index = end;
      continue;
    }
    if (identifierStart(character)) {
      let end = index + 1;
      while (identifierPart(source[end])) end += 1;
      add({ kind: "identifier", value: source.slice(index, end), start: index, end });
      index = end;
      continue;
    }
    if (/[0-9]/u.test(character)) {
      let end = index + 1;
      while (/[A-Za-z0-9_.]/u.test(source[end] ?? "")) end += 1;
      add({ kind: "number", value: source.slice(index, end), start: index, end });
      index = end;
      continue;
    }
    if (character === "{") {
      braceDepth += 1;
      add({ kind: "punctuation", value: character, start: index, end: index + 1 });
      index += 1;
      continue;
    }
    if (character === "}" && stopAtTemplateBrace && braceDepth === 0) return { tokens, end: index + 1 };
    if (character === "}" && braceDepth > 0) braceDepth -= 1;
    add({ kind: "punctuation", value: character, start: index, end: index + 1 });
    index += 1;
  }
  if (stopAtTemplateBrace) assert.fail("unterminated template expression in dist transform");
  return { tokens, end: index };
}

function lex(source) {
  assert.equal(typeof source, "string", "dist transform source must be text");
  return scanCode(source, 0, false, 0).tokens;
}

function stringSpecifier(token, kind) {
  assert.equal(token.kind, "string", "module specifier must be a string literal");
  assert.equal(token.escaped, false, `${kind} module specifier escapes are unsupported`);
  return Object.freeze({ kind, specifier: token.value, start: token.start + 1, end: token.end - 1 });
}

function fromSpecifier(tokens, start, kind) {
  for (let index = start; index < tokens.length && tokens[index].value !== ";"; index += 1) {
    if (tokens[index].kind === "identifier" && tokens[index].value === "from" && tokens[index + 1]?.kind === "string") {
      return stringSpecifier(tokens[index + 1], kind);
    }
  }
  return null;
}

export function collectModuleSpecifiers(source) {
  const tokens = lex(source);
  const specifiers = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "identifier") continue;
    if (token.value === "import") {
      const next = tokens[index + 1];
      if (tokens[index - 1]?.value === ".") continue;
      if (next?.value === ".") continue;
      if (next?.value === "(") {
        const argument = tokens[index + 2];
        const close = tokens[index + 3];
        assert.equal(next.leadingComment || argument?.leadingComment || close?.leadingComment, false, "dynamic import comments are unsupported");
        assert.equal(argument?.kind === "string" && close?.value === ")", true, "dynamic import must contain one exact ordinary string literal");
        specifiers.push(stringSpecifier(argument, "dynamic_import"));
      } else if (next?.kind === "string") {
        specifiers.push(stringSpecifier(next, "side_effect_import"));
      } else {
        const found = fromSpecifier(tokens, index + 1, "static_import");
        if (found !== null) specifiers.push(found);
      }
      continue;
    }
    if (token.value === "export" && ["*", "{"].includes(tokens[index + 1]?.value)) {
      const found = fromSpecifier(tokens, index + 1, "export_from");
      if (found !== null) specifiers.push(found);
    }
  }
  return Object.freeze(specifiers);
}

function isRelativeTypeScriptSpecifier(specifier) {
  return /^(?:\.\/|\.\.\/).+\.ts$/u.test(specifier);
}

export function rewriteRelativeTypeScriptSpecifiers(source) {
  const replacements = collectModuleSpecifiers(source).filter((entry) => isRelativeTypeScriptSpecifier(entry.specifier));
  let rewritten = source;
  for (const entry of [...replacements].sort((left, right) => right.start - left.start)) {
    rewritten = `${rewritten.slice(0, entry.start)}${entry.specifier.slice(0, -3)}.js${rewritten.slice(entry.end)}`;
  }
  const remaining = collectModuleSpecifiers(rewritten).filter((entry) => isRelativeTypeScriptSpecifier(entry.specifier));
  assert.deepEqual(remaining, [], "dist transform retained a relative TypeScript module specifier");
  return rewritten;
}
