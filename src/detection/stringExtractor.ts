import { StringLiteral } from '../types';
import { interpolationEnd, perlDelimitedEnd, perlInterpolationEnd, transformPerlInterpolations } from './interpolations';

/**
 * Extract all string literals from a document based on the host language.
 * Returns the content boundaries (inside delimiters) for each string found.
 */
export function extractStrings(text: string, languageId: string): StringLiteral[] {
  switch (languageId) {
    case 'typescript':
    case 'javascript':
    case 'typescriptreact':
    case 'javascriptreact':
      return extractJavaScriptStrings(text);
    case 'python':
      return extractPythonStrings(text);
    case 'java':
      return extractJavaStrings(text);
    case 'csharp':
      return extractCSharpStrings(text);
    case 'perl':
      return extractPerlStrings(text);
    default:
      return [];
  }
}

/**
 * Get the SQL-parser-friendly placeholder for a given host language.
 * C# (T-SQL): @__p__ (valid T-SQL parameter syntax)
 * Others: __P__ (valid identifier in most dialects)
 */
function getPlaceholder(languageId: string): string {
  return languageId === 'csharp' ? '@__p__' : '__P__';
}

/**
 * Replace interpolation expressions with a SQL-safe placeholder.
 * Returns the cleaned SQL text.
 */
export function replaceInterpolations(content: string, languageId: string): string {
  const placeholder = getPlaceholder(languageId);
  switch (languageId) {
    case 'typescript':
    case 'javascript':
    case 'typescriptreact':
    case 'javascriptreact':
      // Replace ${...} with placeholder, handling nested braces
      return replaceNestedBraces(content, '${', '}', placeholder);
    case 'python':
      // Replace {expr} in f-strings (but not {{ escaped braces }})
      // Use depth-aware matching to handle nested braces like f"{d[key]}"
      return replaceNestedBraces(
        content.replace(/\{\{/g, '__LBRACE__').replace(/\}\}/g, '__RBRACE__'),
        '{', '}', placeholder
      ).replace(/__LBRACE__/g, '{').replace(/__RBRACE__/g, '}');
    case 'csharp':
      // Replace {expr} in interpolated strings — depth-aware for nested braces
      return replaceNestedBraces(
        content.replace(/\{\{/g, '__LBRACE__').replace(/\}\}/g, '__RBRACE__'),
        '{', '}', placeholder
      ).replace(/__LBRACE__/g, '{').replace(/__RBRACE__/g, '}');
    case 'java':
      // Java doesn't have string interpolation (text blocks are plain)
      return content;
    case 'perl':
      return transformPerlInterpolations(content, () => placeholder);
    default:
      return content;
  }
}

function replaceNestedBraces(text: string, open: string, close: string, placeholder: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    const idx = text.indexOf(open, i);
    if (idx === -1) {
      result += text.slice(i);
      break;
    }
    result += text.slice(i, idx);
    // Find matching close brace, accounting for nesting
    let depth = 1;
    let j = idx + open.length;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') { depth++; }
      else if (text[j] === '}') { depth--; }
      j++;
    }
    result += placeholder;
    i = j;
  }
  return result;
}

// ─── JavaScript / TypeScript ───────────────────────────────────────────

function extractJavaScriptStrings(text: string): StringLiteral[] {
  const literals: StringLiteral[] = [];
  let i = 0;
  while (i < text.length) {
    // Skip single-line comments
    if (text[i] === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i === -1) { break; }
      i++;
      continue;
    }
    // Skip multi-line comments
    if (text[i] === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) { break; }
      i += 2;
      continue;
    }
    // Skip regex literals (basic heuristic)
    if (text[i] === '/' && isRegexContext(text, i)) {
      i++;
      while (i < text.length && text[i] !== '/') {
        if (text[i] === '\\') { i++; }
        i++;
      }
      i++; // skip closing /
      continue;
    }
    // Template literal
    if (text[i] === '`') {
      const start = i + 1;
      i++;
      while (i < text.length && text[i] !== '`') {
        if (text[i] === '\\') { i++; }
        else if (text[i] === '$' && text[i + 1] === '{') {
          const end = interpolationEnd(text, i + 2);
          i = end < 0 ? text.length : end;
          continue;
        }
        i++;
      }
      if (i < text.length) {
        literals.push({
          contentStart: start,
          contentEnd: i,
          content: text.slice(start, i),
          type: 'template',
          interpolationWidth: 1,
        });
        i++; // skip closing backtick
      }
      continue;
    }
    // Single or double quoted string
    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      const start = i + 1;
      i++;
      while (i < text.length && text[i] !== quote && text[i] !== '\n') {
        if (text[i] === '\\') { i++; }
        i++;
      }
      if (i < text.length && text[i] === quote) {
        literals.push({
          contentStart: start,
          contentEnd: i,
          content: text.slice(start, i),
          type: quote === '"' ? 'double' : 'single',
        });
        i++;
      }
      continue;
    }
    i++;
  }
  return literals;
}

// ─── Perl ──────────────────────────────────────────────────────────────

function extractPerlStrings(text: string): StringLiteral[] {
  const literals: StringLiteral[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    // __END__ / __DATA__ terminate the Perl source; everything below is freeform data
    if (ch === '_' && (i === 0 || text[i - 1] === '\n') &&
        /^(?:__END__|__DATA__)[\t ]*(?:\r?\n|$)/.test(text.slice(i, i + 10))) {
      break;
    }

    // Line comments (# to end of line, excluding the $# sigil)
    if (ch === '#' && text[i - 1] !== '$') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }

    // POD documentation blocks (=head1 / =pod … =cut at start of line)
    if (ch === '=' && (i === 0 || text[i - 1] === '\n') && /[A-Za-z]/.test(text[i + 1] ?? '')) {
      if (text.startsWith('=cut', i) && /[\t \r\n]/.test(text[i + 4] ?? '\n')) {
        const nl = text.indexOf('\n', i);
        i = nl === -1 ? text.length : nl + 1;
        continue;
      }
      const cutMatch = /\n=cut(?=[\t \r\n]|$)/.exec(text.slice(i));
      if (!cutMatch) { i = text.length; continue; }
      const nl = text.indexOf('\n', i + cutMatch.index + 1);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }

    // Heredoc: <<EOF, <<~EOF, <<'EOF', <<"EOF", <<\EOF
    if (ch === '<' && text[i + 1] === '<') {
      const heredoc = tryExtractPerlHeredoc(text, i);
      if (heredoc) {
        if (heredoc.literal) { literals.push(heredoc.literal); }
        i = heredoc.end;
        continue;
      }
    }

    // Quote-like operators: q//, qq//, qw//, qx//, qr//, m//, s///, tr///, y///
    if ('qmyst'.includes(ch) && isPerlQuoteOperatorPosition(text, i)) {
      const op = tryExtractPerlQuoteLike(text, i);
      if (op) {
        if (op.literal) { literals.push(op.literal); }
        i = op.end;
        continue;
      }
    }

    // Bare regex literal: /.../ (s///, m//, tr///, y/// are handled above)
    if (ch === '/' && isPerlRegexContext(text, i)) {
      let end = perlDelimitedEnd(text, i, '/', true);
      if (end < 0) { i = text.length; continue; }
      while (end < text.length && /[A-Za-z]/.test(text[end])) { end++; }
      i = end;
      continue;
    }

    // Quote-named special variables: $" (list separator), $' and $` (match captures)
    if (ch === '$' && (text[i + 1] === '"' || text[i + 1] === "'" || text[i + 1] === '`')) {
      i += 2;
      continue;
    }

    // Backtick command execution (`...`): skip so quotes inside shell commands are ignored
    if (ch === '`') {
      i++;
      while (i < text.length && text[i] !== '`') {
        if (text[i] === '\\') { i++; }
        i++;
      }
      if (i < text.length) { i++; }
      continue;
    }

    // Single-quoted string (multiline allowed, non-interpolating)
    if (ch === "'") {
      const start = i + 1;
      i++;
      while (i < text.length && text[i] !== "'") {
        if (text[i] === '\\') { i++; }
        i++;
      }
      if (i < text.length) {
        literals.push({
          contentStart: start,
          contentEnd: i,
          content: text.slice(start, i),
          type: 'template',
          interpolationWidth: 0,
        });
        i++;
      }
      continue;
    }

    // Double-quoted string (multiline allowed, interpolating)
    if (ch === '"') {
      const start = i + 1;
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '$' || text[i] === '@') {
          const end = perlInterpolationEnd(text, i);
          if (end > i) { i = end; continue; }
        }
        i++;
      }
      if (i < text.length && text[i] === '"') {
        literals.push({
          contentStart: start,
          contentEnd: i,
          content: text.slice(start, i),
          type: 'template',
          interpolationWidth: 1,
        });
        i++;
      }
      continue;
    }

    i++;
  }
  return literals;
}

const PERL_REGEX_KEYWORDS = new Set([
  'if', 'elsif', 'unless', 'while', 'until', 'when',
  'and', 'or', 'not', 'xor', 'return', 'die', 'warn',
  'split', 'grep', 'map', 'print', 'say', 'push', 'unshift', 'join',
]);

function isPerlQuoteOperatorPosition(text: string, pos: number): boolean {
  const prev = text[pos - 1] ?? '';
  if (/[A-Za-z0-9_$@%*&]/.test(prev)) { return false; }
  if ((prev === '>' && text[pos - 2] === '-') || (prev === ':' && text[pos - 2] === ':')) {
    return false;
  }
  if (/\b(?:sub|package|use|no|require)\s+$/.test(text.slice(Math.max(0, pos - 16), pos))) {
    return false;
  }
  return true;
}

/** Heuristic for whether `/` opens a regex rather than performing division. */
function isPerlRegexContext(text: string, pos: number): boolean {
  let j = pos - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r' || text[j] === '\n')) {
    j--;
  }
  if (j < 0) { return true; }
  if (text[j] === '~' && (text[j - 1] === '=' || text[j - 1] === '!')) { return true; }
  if ('=(,;{[!&|?:'.includes(text[j])) { return true; }
  if (/[A-Za-z_]/.test(text[j])) {
    let start = j;
    while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) { start--; }
    const sigil = text[start - 1] ?? '';
    if ('$@%*&'.includes(sigil)) { return false; }
    if ((sigil === '>' && text[start - 2] === '-') || (sigil === ':' && text[start - 2] === ':')) {
      return false;
    }
    return PERL_REGEX_KEYWORDS.has(text.slice(start, j + 1));
  }
  return false;
}

function tryExtractPerlQuoteLike(
  text: string, start: number,
): { literal?: StringLiteral; end: number } | undefined {
  let op = '';
  for (const candidate of ['qq', 'qw', 'qx', 'qr', 'tr', 'q', 'm', 's', 'y']) {
    if (text.startsWith(candidate, start)) { op = candidate; break; }
  }
  if (!op) { return undefined; }
  // `-s` is the file-size filetest operator (e.g. `if (-s $fh)` or `-s 'file'`), not substitution
  if (op === 's' && text[start - 1] === '-' && text[start - 2] !== '-') { return undefined; }

  let i = start + op.length;
  if (/[A-Za-z0-9_]/.test(text[i] ?? '')) { return undefined; }

  let hadWhitespace = false;
  while (i < text.length && /[ \t\r\n]/.test(text[i])) {
    hadWhitespace = true;
    i++;
  }

  // Fat comma autoquoting (e.g. `{ q => 1 }`) is a bareword key, not a quote-like string
  if (text.startsWith('=>', i)) { return undefined; }

  const delim = text[i];
  if (!delim || delim === '\\' || /[A-Za-z0-9_\s]/.test(delim) || (hadWhitespace && delim === '#')) {
    return undefined;
  }
  // A closing bracket cannot open a quote-like string; `$h{ q }` is an autoquoted key
  if (')]}>'.includes(delim)) { return undefined; }

  // Single-quote delimiters disable interpolation for m/s/qr/qx, while qq'...' still interpolates
  const interpolating = op === 'qq'
    || ((op === 'qx' || op === 'qr' || op === 'm' || op === 's') && delim !== "'");
  const skipOnly = op === 'qw' || op === 'qx' || op === 'qr' || op === 'm'
    || op === 's' || op === 'tr' || op === 'y';

  const firstEnd = perlDelimitedEnd(text, i, delim, interpolating);
  if (firstEnd < 0) { return undefined; }
  let end = firstEnd;

  // Substitution and transliteration carry a second delimited section
  if (op === 's' || op === 'tr' || op === 'y') {
    if ('([{<'.includes(delim)) {
      let j = end;
      while (j < text.length && /[ \t\r\n]/.test(text[j])) { j++; }
      const secondDelim = text[j] ?? '';
      if (!secondDelim || secondDelim === '\\' || /[A-Za-z0-9_\s]/.test(secondDelim) || ')]}>'.includes(secondDelim)) {
        return { end };
      }
      const secondInterpolating = op === 's' && secondDelim !== "'";
      const secondEnd = perlDelimitedEnd(text, j, secondDelim, secondInterpolating);
      if (secondEnd < 0) { return { end }; }
      end = secondEnd;
    } else {
      // Non-bracketing delimiters reuse the same character; the body starts immediately
      const secondInterpolating = op === 's' && delim !== "'";
      const secondEnd = perlDelimitedEnd(text, end, delim, secondInterpolating, false);
      if (secondEnd < 0) { return { end }; }
      end = secondEnd;
    }
  }

  // Trailing modifiers are only valid on the regex-like operators
  if (op === 'm' || op === 's' || op === 'tr' || op === 'y' || op === 'qr') {
    while (end < text.length && /[A-Za-z]/.test(text[end])) { end++; }
  }

  if (skipOnly) { return { end }; }
  return {
    literal: {
      contentStart: i + 1,
      contentEnd: firstEnd - 1,
      content: text.slice(i + 1, firstEnd - 1),
      type: 'template',
      interpolationWidth: interpolating ? 1 : 0,
    },
    end,
  };
}

function tryExtractPerlHeredoc(
  text: string, start: number,
): { literal?: StringLiteral; end: number } | undefined {
  let i = start + 2;
  let indented = false;
  if (text[i] === '~') { indented = true; i++; }

  const wsStart = i;
  while (text[i] === ' ' || text[i] === '\t') { i++; }
  const hadSpace = i > wsStart;

  let interpolating = true;
  let skipOnly = false;
  let quote = '';
  if (text[i] === '\\') {
    if (hadSpace && !indented) { return undefined; }
    interpolating = false;
    i++;
  } else if (text[i] === "'" || text[i] === '"' || text[i] === '`') {
    quote = text[i];
    interpolating = quote === '"';
    skipOnly = quote === '`';
    i++;
  } else if (hadSpace) {
    // Unquoted barewords cannot follow whitespace after << or <<~ (e.g. `1 << SHIFT` is bitshift)
    return undefined;
  }

  let terminator: string;
  if (quote) {
    const termStart = i;
    while (i < text.length && text[i] !== quote && text[i] !== '\n') {
      if (text[i] === '\\' && text[i + 1] === quote) { i += 2; continue; }
      i++;
    }
    if (text[i] !== quote) { return undefined; }
    terminator = text.slice(termStart, i);
    if (terminator.length === 0) { return undefined; }
    i++;
  } else {
    if (!/[A-Za-z_]/.test(text[i] ?? '')) { return undefined; }
    const termStart = i;
    while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) { i++; }
    terminator = text.slice(termStart, i);
  }

  const headerEnd = text.indexOf('\n', i);
  if (headerEnd === -1) { return undefined; }
  const bodyStart = headerEnd + 1;

  let pos = bodyStart;
  let bodyEnd = -1;
  let closingIndent = '';
  let afterEnd = text.length;
  while (pos <= text.length) {
    let eol = text.indexOf('\n', pos);
    if (eol === -1) { eol = text.length; }
    const line = text.slice(pos, eol).replace(/\r$/, '');
    if (indented) {
      const lineIndent = line.match(/^[\t ]*/)?.[0] ?? '';
      if (line.slice(lineIndent.length) === terminator) {
        bodyEnd = pos;
        closingIndent = lineIndent;
        afterEnd = eol === text.length ? text.length : eol + 1;
        break;
      }
    } else if (line === terminator) {
      bodyEnd = pos;
      afterEnd = eol === text.length ? text.length : eol + 1;
      break;
    }
    if (eol === text.length) { break; }
    pos = eol + 1;
  }
  if (bodyEnd === -1) { return undefined; }
  if (skipOnly) { return { end: afterEnd }; }

  return {
    literal: {
      contentStart: bodyStart,
      contentEnd: bodyEnd,
      content: text.slice(bodyStart, bodyEnd),
      type: 'heredoc',
      interpolationWidth: interpolating ? 1 : 0,
      closingIndent,
    },
    end: afterEnd,
  };
}

function isRegexContext(text: string, pos: number): boolean {
  // Simple heuristic: if preceded by =, (, [, !, &, |, ^, ~, ,, ;, :, {, }
  // or start of line, it's likely a regex
  let j = pos - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) { j--; }
  if (j < 0) { return true; }
  return /[=([!&|^~,;:{}?+\-*%<>]/.test(text[j]);
}

// ─── Python ────────────────────────────────────────────────────────────

function extractPythonStrings(text: string): StringLiteral[] {
  const literals: StringLiteral[] = [];
  let i = 0;
  while (i < text.length) {
    // Skip comments
    if (text[i] === '#') {
      i = text.indexOf('\n', i);
      if (i === -1) { break; }
      i++;
      continue;
    }
    // Skip f/r/b/u prefix
    let prefix = '';
    if (/[fFrRbBuU]/.test(text[i]) && (text[i + 1] === '"' || text[i + 1] === "'")) {
      prefix = text[i];
      i++;
    } else if (
      /[fFrRbBuU]/.test(text[i]) && /[fFrRbBuU]/.test(text[i + 1]) &&
      (text[i + 2] === '"' || text[i + 2] === "'")
    ) {
      prefix = text.slice(i, i + 2);
      i += 2;
    }

    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      // Triple quote
      if (text[i + 1] === quote && text[i + 2] === quote) {
        const tripleQuote = quote.repeat(3);
        const start = i + 3;
        i += 3;
        const endIdx = text.indexOf(tripleQuote, i);
        if (endIdx !== -1) {
          literals.push({
            contentStart: start,
            contentEnd: endIdx,
            content: text.slice(start, endIdx),
            type: 'triple',
            interpolationWidth: /f/i.test(prefix) ? 1 : 0,
            raw: /r/i.test(prefix),
          });
          i = endIdx + 3;
        } else {
          i = text.length;
        }
        continue;
      }
      // Single-line string
      const start = i + 1;
      i++;
      while (i < text.length && text[i] !== quote && text[i] !== '\n') {
        if (/f/i.test(prefix) && text.startsWith('{{', i)) { i += 2; continue; }
        if (/f/i.test(prefix) && text[i] === '{') {
          const end = interpolationEnd(text, i + 1, 1, 'python');
          i = end < 0 ? text.length : end;
          continue;
        }
        if (text[i] === '\\') { i++; }
        i++;
      }
      if (i < text.length && text[i] === quote) {
        literals.push({
          contentStart: start,
          contentEnd: i,
          content: text.slice(start, i),
          type: quote === '"' ? 'double' : 'single',
          interpolationWidth: /f/i.test(prefix) ? 1 : 0,
          raw: /r/i.test(prefix),
        });
        i++;
      }
      continue;
    }

    // Consume unused prefix character if no string followed
    if (prefix) { continue; }
    i++;
  }
  return literals;
}

// ─── Java ──────────────────────────────────────────────────────────────

function extractJavaStrings(text: string): StringLiteral[] {
  const literals: StringLiteral[] = [];
  let i = 0;
  while (i < text.length) {
    // Skip single-line comments
    if (text[i] === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i === -1) { break; }
      i++;
      continue;
    }
    // Skip multi-line comments
    if (text[i] === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) { break; }
      i += 2;
      continue;
    }
    // Skip char literals
    if (text[i] === "'") {
      i++;
      if (i < text.length && text[i] === '\\') { i++; }
      i++;
      if (i < text.length && text[i] === "'") { i++; }
      continue;
    }
    // Text block (Java 13+)
    if (text[i] === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
      i += 3;
      // Skip whitespace until newline
      while (i < text.length && text[i] !== '\n') { i++; }
      if (i < text.length) { i++; } // skip newline
      const start = i;
      const endIdx = text.indexOf('"""', i);
      if (endIdx !== -1) {
        literals.push({
          contentStart: start,
          contentEnd: endIdx,
          content: text.slice(start, endIdx),
          type: 'textblock',
        });
        i = endIdx + 3;
      } else {
        i = text.length;
      }
      continue;
    }
    // Regular string
    if (text[i] === '"') {
      const start = i + 1;
      i++;
      while (i < text.length && text[i] !== '"' && text[i] !== '\n') {
        if (text[i] === '\\') { i++; }
        i++;
      }
      if (i < text.length && text[i] === '"') {
        literals.push({
          contentStart: start,
          contentEnd: i,
          content: text.slice(start, i),
          type: 'double',
        });
        i++;
      }
      continue;
    }
    i++;
  }
  return literals;
}

// ─── C# ────────────────────────────────────────────────────────────────

function extractCSharpStrings(text: string): StringLiteral[] {
  const literals: StringLiteral[] = [];
  let i = 0;
  while (i < text.length) {
    // Skip single-line comments
    if (text[i] === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i === -1) { break; }
      i++;
      continue;
    }
    // Skip multi-line comments
    if (text[i] === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) { break; }
      i += 2;
      continue;
    }
    // Skip char literals
    if (text[i] === "'") {
      i++;
      if (i < text.length && text[i] === '\\') { i++; }
      i++;
      if (i < text.length && text[i] === "'") { i++; }
      continue;
    }

    // Raw string literal (C# 11): """ or $""" or $$"""
    let dollarCount = 0;
    let peekI = i;
    while (peekI < text.length && text[peekI] === '$') {
      dollarCount++;
      peekI++;
    }
    if (text[peekI] === '"' && text[peekI + 1] === '"' && text[peekI + 2] === '"') {
      let quoteCount = 0;
      while (text[peekI + quoteCount] === '"') { quoteCount++; }
      const start = peekI + quoteCount;
      const delimiter = '"'.repeat(quoteCount);
      const endIdx = text.indexOf(delimiter, start);
      if (endIdx !== -1) {
        literals.push({
          contentStart: start,
          contentEnd: endIdx,
          content: text.slice(start, endIdx),
          type: 'raw',
          raw: true,
          interpolationWidth: dollarCount,
        });
        i = endIdx + quoteCount;
      } else {
        i = text.length;
      }
      continue;
    }

    // Interpolated verbatim: $@" or @$"
    if (
      (text[i] === '$' && text[i + 1] === '@' && text[i + 2] === '"') ||
      (text[i] === '@' && text[i + 1] === '$' && text[i + 2] === '"')
    ) {
      i += 3;
      const start = i;
      while (i < text.length) {
        if (text.startsWith('{{', i)) { i += 2; continue; }
        if (text[i] === '{') {
          const end = interpolationEnd(text, i + 1);
          i = end < 0 ? text.length : end;
          continue;
        }
        if (text[i] === '"' && text[i + 1] === '"') {
          i += 2; // escaped quote in verbatim
          continue;
        }
        if (text[i] === '"') { break; }
        i++;
      }
      if (i < text.length) {
        literals.push({
          contentStart: start,
          contentEnd: i,
          content: text.slice(start, i),
          type: 'verbatim',
          interpolationWidth: 1,
        });
        i++;
      }
      continue;
    }

    // Verbatim string: @"
    if (text[i] === '@' && text[i + 1] === '"') {
      i += 2;
      const start = i;
      while (i < text.length) {
        if (text[i] === '"' && text[i + 1] === '"') {
          i += 2; // escaped quote
          continue;
        }
        if (text[i] === '"') { break; }
        i++;
      }
      if (i < text.length) {
        literals.push({
          contentStart: start,
          contentEnd: i,
          content: text.slice(start, i),
          type: 'verbatim',
        });
        i++;
      }
      continue;
    }

    // Interpolated string: $"
    if (text[i] === '$' && text[i + 1] === '"') {
      i += 2;
      const start = i;
      while (i < text.length && text[i] !== '"' && text[i] !== '\n') {
        if (text.startsWith('{{', i)) { i += 2; continue; }
        if (text[i] === '\\') { i++; }
        else if (text[i] === '{' && text[i + 1] !== '{') {
          const end = interpolationEnd(text, i + 1);
          i = end < 0 ? text.length : end;
          continue;
        }
        i++;
      }
      if (i < text.length && text[i] === '"') {
        literals.push({
          contentStart: start,
          contentEnd: i,
          content: text.slice(start, i),
          type: 'double',
          interpolationWidth: 1,
        });
        i++;
      }
      continue;
    }

    // Regular string: "
    if (text[i] === '"') {
      const start = i + 1;
      i++;
      while (i < text.length && text[i] !== '"' && text[i] !== '\n') {
        if (text[i] === '\\') { i++; }
        i++;
      }
      if (i < text.length && text[i] === '"') {
        literals.push({
          contentStart: start,
          contentEnd: i,
          content: text.slice(start, i),
          type: 'double',
        });
        i++;
      }
      continue;
    }
    i++;
  }
  return literals;
}
