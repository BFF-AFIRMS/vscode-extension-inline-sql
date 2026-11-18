import { StringLiteral } from '../types';

/** Find the end of a host expression, ignoring braces in quoted values/comments. */
export function interpolationEnd(text: string, start: number, width = 1, languageId = 'typescript'): number {
  const frames: Array<{ mode: string; depth: number; width: number }> = [{ mode: 'code', depth: 0, width }];
  for (let i = start; i < text.length; i++) {
    const frame = frames[frames.length - 1];
    const ch = text[i];
    if (frame.mode !== 'code') {
      if (ch === '\\') { i++; }
      else if (ch === frame.mode) { frames.pop(); }
      else if (frame.mode === '`' && text.startsWith('${', i)) {
        frames.push({ mode: 'code', depth: 0, width: 1 });
        i++;
      }
    } else if (ch === '"' || ch === "'" || ch === '`') {
      frames.push({ mode: ch, depth: 0, width: 0 });
    } else if (languageId !== 'python' && text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) { return -1; }
      i = end + 1;
    } else if ((languageId !== 'python' && text.startsWith('//', i)) || (languageId === 'python' && ch === '#')) {
      const end = text.indexOf('\n', i + 2);
      if (end < 0) { return -1; }
      i = end;
    } else if (ch === '{') {
      frame.depth++;
    } else if (ch === '}') {
      if (frame.depth === 0 && text.startsWith('}'.repeat(frame.width), i)) {
        i += frame.width - 1;
        frames.pop();
        if (frames.length === 0) { return i + 1; }
      } else { frame.depth--; }
    }
  }
  return -1;
}

/** Replaces only actual interpolations, preserving ordinary SQL braces verbatim. */
export function transformInterpolations(
  literal: StringLiteral, languageId: string, replace: (expression: string) => string,
): string {
  const width = literal.interpolationWidth ?? 0;
  if (!width) { return literal.content; }
  if (languageId === 'perl') { return transformPerlInterpolations(literal.content, replace); }
  const js = /^(?:javascript|typescript)/.test(languageId);
  const open = js ? '${' : '{'.repeat(width);
  const text = literal.content;
  let result = '';
  for (let i = 0; i < text.length;) {
    if (js && text[i] === '\\') {
      result += text.slice(i, i + 2);
      i += 2;
    } else if (!js && literal.type !== 'raw' && (text.startsWith('{{', i) || text.startsWith('}}', i))) {
      result += text.slice(i, i + 2);
      i += 2;
    } else if (text.startsWith(open, i)) {
      const end = interpolationEnd(text, i + open.length, width, languageId);
      if (end < 0) { return result + text.slice(i); }
      result += replace(text.slice(i, end));
      i = end;
    } else {
      result += text[i++];
    }
  }
  return result;
}

// ─── Perl ──────────────────────────────────────────────────────────────

/**
 * Single-character Perl punctuation scalars that follow a `$` sigil.
 * Deliberately excludes `\`, quotes, and brackets: consuming them would swallow
 * escape sequences or the closing delimiter of the enclosing literal.
 */
const PERL_SPECIAL_VARS = new Set([
  '&', '+', '@', '/', ',', ';', '%', '=', '-', '~', '^', ':', '?', '!', '.', '*', '$',
]);

/**
 * Find the exclusive end offset of the Perl interpolation starting at `start`
 * (a `$` or `@` sigil). Returns `start` when the sigil is literal.
 */
export function perlInterpolationEnd(text: string, start: number, allowPunctuation = true): number {
  const sigil = text[start];
  if (sigil !== '$' && sigil !== '@') { return start; }
  let i = start + 1;
  if (i >= text.length) { return start; }

  // Array last-index sigil: $#items, $#$aref, $#{expr}, or standalone $#
  if (sigil === '$' && text[i] === '#') {
    let j = i + 1;
    while (text[j] === '$') { j++; }
    if (text[j] === '{') {
      const end = skipPerlBalanced(text, j, '{', '}');
      return end < 0 ? start : end;
    }
    if (/[A-Za-z_]/.test(text[j] ?? '')) {
      return scanPerlIdent(text, j);
    }
    return i + 1;
  }

  // Scalar dereference chains: $$ref, @$ids, $$$ref, $${expr}, @${expr}
  let deref = i;
  while (text[deref] === '$') { deref++; }
  if (deref > i && (text[deref] === '{' || /[A-Za-z_]/.test(text[deref] ?? ''))) {
    i = deref;
  }

  // Braced variable/expression: ${...} / @{...}
  if (text[i] === '{') {
    const end = skipPerlBalanced(text, i, '{', '}');
    return end < 0 ? start : end;
  }

  // Named variable with optional :: package qualifiers and postfix subscripts/derefs
  if (/[A-Za-z_]/.test(text[i])) {
    i = scanPerlIdent(text, i);
    return perlPostfixEnd(text, i);
  }

  // Numbered regex capture scalars $1..$n
  if (sigil === '$' && /[0-9]/.test(text[i])) {
    i++;
    while (i < text.length && /[0-9]/.test(text[i])) { i++; }
    return i;
  }

  if (allowPunctuation && sigil === '$' && PERL_SPECIAL_VARS.has(text[i])) { return i + 1; }
  if (allowPunctuation && sigil === '@' && (text[i] === '-' || text[i] === '+')) { return i + 1; }
  return start;
}

function scanPerlIdent(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) { i++; }
  while (text[i] === ':' && text[i + 1] === ':' && /[A-Za-z0-9_]/.test(text[i + 2] ?? '')) {
    i += 2;
    while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) { i++; }
  }
  return i;
}

function perlPostfixEnd(text: string, start: number): number {
  let i = start;
  for (;;) {
    const ch = text[i];
    if (ch === '{') {
      const end = skipPerlBalanced(text, i, '{', '}');
      if (end < 0) { return i; }
      i = end;
    } else if (ch === '[') {
      const end = skipPerlBalanced(text, i, '[', ']');
      if (end < 0) { return i; }
      i = end;
    } else if (ch === '-' && text[i + 1] === '>') {
      const next = text[i + 2];
      if (next === '{' || next === '[') {
        const end = skipPerlBalanced(text, i + 2, next, next === '{' ? '}' : ']');
        if (end < 0) { return i; }
        i = end;
      } else if (next === '@' || next === '$' || next === '%' || next === '&' || next === '*') {
        // Postfix dereference: ->@*, ->$*, ->$#*, ->%*, ->&*, ->**, ->@[...], ->@{...}
        let j = i + 3;
        if (next === '$' && text[j] === '#') { j++; }
        if (text[j] === '*') { i = j + 1; continue; }
        if (text[j] === '[' || text[j] === '{') {
          const end = skipPerlBalanced(text, j, text[j], text[j] === '[' ? ']' : '}');
          if (end < 0) { return i; }
          i = end;
          continue;
        }
        return i;
      } else {
        return i;
      }
    } else {
      return i;
    }
  }
}

function skipPerlBalanced(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      for (i++; i < text.length; i++) {
        if (text[i] === '\\') { i++; continue; }
        if (text[i] === quote) { break; }
      }
      continue;
    }
    if (ch === open) { depth++; }
    else if (ch === close) {
      depth--;
      if (depth === 0) { return i + 1; }
    }
  }
  return -1;
}

/**
 * Scan a delimited Perl construct (regex body or quote-like operator body).
 * Returns the index just past the closing delimiter, or -1 when unterminated.
 * Punctuation variables are not consumed here so `$/` cannot eat the closing `/`.
 */
export function perlDelimitedEnd(
  text: string, start: number, delim: string, interpolating: boolean, skipDelim = true,
): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };
  const close = skipDelim ? pairs[delim] : undefined;
  let i = skipDelim ? start + 1 : start;
  if (close) {
    let depth = 1;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') { i += 2; continue; }
      if (interpolating && (ch === '$' || ch === '@')) {
        const end = perlInterpolationEnd(text, i, false);
        if (end > i) { i = end; continue; }
      }
      if (ch === close) {
        depth--;
        if (depth === 0) { return i + 1; }
      } else if (ch === delim) {
        depth++;
      }
      i++;
    }
    return -1;
  }
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (interpolating && (ch === '$' || ch === '@')) {
      const end = perlInterpolationEnd(text, i, false);
      if (end > i) { i = end; continue; }
    }
    if (ch === delim) { return i + 1; }
    i++;
  }
  return -1;
}

/** Locate all unescaped Perl interpolation spans inside an interpolating string's content. */
export function findPerlInterpolationSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '$' || text[i] === '@') {
      const end = perlInterpolationEnd(text, i);
      if (end > i) {
        spans.push({ start: i, end });
        i = end;
        continue;
      }
    }
    i++;
  }
  return spans;
}

/** Replace Perl `$...` / `@...` interpolations using the supplied replacement callback. */
export function transformPerlInterpolations(text: string, replace: (expression: string) => string): string {
  const spans = findPerlInterpolationSpans(text);
  if (spans.length === 0) { return text; }
  let result = '';
  let cursor = 0;
  for (const span of spans) {
    result += text.slice(cursor, span.start) + replace(text.slice(span.start, span.end));
    cursor = span.end;
  }
  return result + text.slice(cursor);
}
