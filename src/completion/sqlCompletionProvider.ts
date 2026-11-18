import * as vscode from 'vscode';
import { findSqlRegionAtOffset } from '../detection/sqlDetector';
import { documentSqlRegions } from '../configuration';
import { buildCompletionItems } from './sqlKeywords';
import { SchemaInfo, TableInfo } from '../types';

export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  private keywordItems: vscode.CompletionItem[];
  private schemaProvider: (() => SchemaInfo | undefined | Promise<SchemaInfo | undefined>) | undefined;

  constructor(schemaProvider?: () => SchemaInfo | undefined | Promise<SchemaInfo | undefined>) {
    this.keywordItems = buildCompletionItems();
    this.schemaProvider = schemaProvider;
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[] | undefined> {
    const text = document.getText();
    const offset = document.offsetAt(position);

    // Detect SQL regions and check if cursor is inside one
    const regions = documentSqlRegions(document);
    const region = findSqlRegionAtOffset(regions, offset);

    if (!region) {
      return undefined;
    }

    const items: vscode.CompletionItem[] = [...this.keywordItems];

    // Context-aware: determine what came before the cursor
    const regionSql = text.slice(region.startOffset, region.endOffset);
    const sqlBeforeCursor = text.slice(region.startOffset, offset);
    const context = getCompletionContext(sqlBeforeCursor);

    // Derived tables are described by the SQL text itself, so their columns need no connection.
    const derivedTables = extractDerivedTables(regionSql);

    // Add schema-based completions if available
    const schema = await this.schemaProvider?.();
    if (_token.isCancellationRequested) { return undefined; }
    if (context === 'table') {
      if (schema) { items.push(...buildTableCompletionItems(schema)); }
    } else if (context === 'column') {
      const tableName = getTableNameBeforeDot(sqlBeforeCursor);
      if (tableName) {
        // A subquery alias shadows a table of the same name.
        const derivedColumns = derivedTables.get(tableName.toLowerCase());
        if (derivedColumns) {
          items.push(...buildDerivedColumnCompletionItems(derivedColumns));
        } else if (schema) {
          items.push(...buildColumnCompletionItems(schema, resolveTableReference(tableName, regionSql)));
        }
      } else {
        // Add all columns from all referenced tables, derived ones included
        for (const columns of derivedTables.values()) {
          items.push(...buildDerivedColumnCompletionItems(columns));
        }
        if (schema) {
          for (const table of extractReferencedTables(regionSql, schema)) {
            const name = table.schema ? `${table.schema}.${table.name}` : table.name;
            items.push(...buildColumnCompletionItems(schema, name));
          }
        }
      }
    }

    return items;
  }
}

type CompletionContext = 'table' | 'column' | 'general';

export function getCompletionContext(sqlBefore: string): CompletionContext {
  const trimmed = sqlBefore.replace(/\s+/g, ' ').trimEnd().toUpperCase();

  // After FROM, JOIN, INTO, UPDATE, TABLE → suggest tables
  if (/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s*$/i.test(trimmed)) {
    return 'table';
  }

  // After "tablename." → suggest columns
  if (/\w+\.\s*$/i.test(sqlBefore.trimEnd())) {
    return 'column';
  }

  // After SELECT, WHERE, ON, SET, BY, HAVING → suggest columns
  if (/\b(?:SELECT|WHERE|ON|SET|BY|HAVING|AND|OR)\s*$/i.test(trimmed)) {
    return 'column';
  }

  return 'general';
}

/** SQL keywords that should not be treated as table names */
const SQL_KEYWORD_SET = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'JOIN', 'ON',
  'INSERT', 'INTO', 'UPDATE', 'DELETE', 'SET', 'VALUES',
  'GROUP', 'ORDER', 'BY', 'HAVING', 'LIMIT', 'OFFSET',
  'INNER', 'LEFT', 'RIGHT', 'OUTER', 'CROSS', 'FULL',
  'CREATE', 'ALTER', 'DROP', 'TABLE', 'INDEX', 'VIEW',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AS', 'NOT', 'NULL',
  'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS', 'UNION', 'ALL',
  'USING', 'WITH', 'NATURAL', 'LATERAL', 'FETCH', 'ROWS', 'ONLY', 'FOR',
  'INTERSECT', 'EXCEPT', 'PARTITION', 'WINDOW', 'STRAIGHT_JOIN',
]);

function getTableNameBeforeDot(sqlBefore: string): string | undefined {
  const match = sqlBefore.trimEnd().match(/(\w+)\.\s*$/);
  if (!match) { return undefined; }
  const name = match[1];
  // Skip SQL keywords that happen to precede a dot
  if (SQL_KEYWORD_SET.has(name.toUpperCase())) { return undefined; }
  return name;
}

/** A table named in a FROM/JOIN/INTO/UPDATE clause, with its alias when one is present. */
interface TableReference {
  table: string;
  alias?: string;
}

/**
 * Collect table references from the SQL text. The word following a table is an alias
 * only when it is not a keyword, so `FROM stock AS plot WHERE` yields a table/alias pair
 * instead of a table called `stock` aliased `WHERE`.
 */
function extractTableReferences(sql: string): TableReference[] {
  const references: TableReference[] = [];
  // Built locally so no shared mutable lastIndex leaks between calls.
  const pattern = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)(?:\s+(?:AS\s+)?([A-Za-z_][\w$]*))?/gi;
  for (const match of sql.matchAll(pattern)) {
    const alias = match[2] && !SQL_KEYWORD_SET.has(match[2].toUpperCase()) ? match[2] : undefined;
    references.push({ table: match[1], alias });
  }
  return references;
}

/** Resolve an alias used before a dot (`plot.`) to the table it stands for. */
function resolveTableReference(name: string, sql: string): string {
  const lower = name.toLowerCase();
  const reference = extractTableReferences(sql).find(r => r.alias?.toLowerCase() === lower);
  return reference ? reference.table : name;
}

/** Find a table by name, preferring an explicit `schema.table` qualifier when given. */
function findTable(schema: SchemaInfo, name: string): TableInfo | undefined {
  const separator = name.lastIndexOf('.');
  const qualifier = separator > 0 ? name.slice(0, separator).toLowerCase() : undefined;
  const tableName = (separator > 0 ? name.slice(separator + 1) : name).toLowerCase();
  const matches = schema.tables.filter(t => t.name.toLowerCase() === tableName);
  return matches.find(t => qualifier !== undefined && t.schema?.toLowerCase() === qualifier) ?? matches[0];
}

function extractReferencedTables(sql: string, schema: SchemaInfo): TableInfo[] {
  const tables: TableInfo[] = [];
  const seen = new Set<string>();
  for (const reference of extractTableReferences(sql)) {
    const table = findTable(schema, reference.table);
    if (!table) { continue; }
    const key = JSON.stringify([table.schema ?? null, table.name]);
    if (seen.has(key)) { continue; }
    seen.add(key);
    tables.push(table);
  }
  return tables;
}

/**
 * Blank out comments and single-quoted strings so parentheses, keywords and commas inside
 * them are not mistaken for structure. Offsets are preserved, so the mask can locate
 * positions in the original text.
 */
function maskSqlLiterals(sql: string): string {
  const chars = sql.split('');
  for (let i = 0; i < sql.length; i++) {
    let end = -1;
    if (sql[i] === "'") {
      end = i + 1;
      // A doubled quote is an escaped quote, not the end of the literal.
      while (end < sql.length && !(sql[end] === "'" && sql[end + 1] !== "'")) {
        end += sql[end] === "'" ? 2 : 1;
      }
      end = Math.min(end, sql.length - 1);
    } else if (sql.startsWith('--', i)) {
      const newline = sql.indexOf('\n', i + 2);
      end = newline < 0 ? sql.length - 1 : newline;
    } else if (sql.startsWith('/*', i)) {
      const close = sql.indexOf('*/', i + 2);
      end = close < 0 ? sql.length - 1 : close + 1;
    }
    if (end < 0) { continue; }
    for (let j = i; j <= end; j++) { chars[j] = ' '; }
    i = end;
  }
  return chars.join('');
}

/** Parenthesis depth immediately before each offset of the masked SQL text. */
function parenDepths(masked: string): number[] {
  const depths = new Array<number>(masked.length);
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    depths[i] = depth;
    if (masked[i] === '(') { depth++; }
    else if (masked[i] === ')') { depth = Math.max(0, depth - 1); }
  }
  return depths;
}

/**
 * Offset of the `)` closing the `(` at `open`, or -1 when it is unbalanced.
 * `depths` records the depth *before* each offset, so the `(` sits one level below the
 * `)` that closes it.
 */
function matchingParen(masked: string, depths: number[], open: number): number {
  for (let i = open + 1; i < masked.length; i++) {
    if (masked[i] === ')' && depths[i] === depths[open] + 1) { return i; }
  }
  return -1;
}

/** Derived-table aliases resolved to their output column names, keyed by lower-cased alias. */
function extractDerivedTables(sql: string): Map<string, string[]> {
  const masked = maskSqlLiterals(sql);
  const depths = parenDepths(masked);
  const tables = new Map<string, string[]>();
  const pattern = /\b(?:from|join)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    const open = match.index + match[0].length - 1;
    const close = matchingParen(masked, depths, open);
    if (close < 0) { continue; }
    const alias = /^\s*(?:as\s+)?([a-z_][\w$]*)/i.exec(masked.slice(close + 1))?.[1];
    if (!alias || SQL_KEYWORD_SET.has(alias.toUpperCase())) { continue; }
    const columns = selectListColumns(sql.slice(open + 1, close));
    // An unknown select list must not shadow a table of the same name.
    if (columns.length > 0) { tables.set(alias.toLowerCase(), columns); }
  }
  return tables;
}

/** Output column names of a subquery's SELECT list; `*` contributes nothing. */
function selectListColumns(query: string): string[] {
  const masked = maskSqlLiterals(query);
  const depths = parenDepths(masked);
  let end = masked.length;
  const fromPattern = /\bfrom\b/gi;
  let match: RegExpExecArray | null;
  while ((match = fromPattern.exec(masked)) !== null) {
    if (depths[match.index] === 0) { end = match.index; break; }
  }
  const head = /^\s*select\s+(?:distinct\s+|all\s+)?/i.exec(masked.slice(0, end));
  if (!head) { return []; }
  const names: string[] = [];
  let start = head[0].length;
  for (let i = start; i <= end; i++) {
    if (i === end || (masked[i] === ',' && depths[i] === 0)) {
      const name = outputColumnName(query.slice(start, i));
      if (name) { names.push(name); }
      start = i + 1;
    }
  }
  return names;
}

/** Output name of one select-list entry: its alias, its identifier, or its function name. */
function outputColumnName(entry: string): string | undefined {
  const trimmed = entry.trim();
  if (!trimmed) { return undefined; }
  // Explicit alias: `expr AS name`.
  const explicit = /^.*\s+as\s+([a-z_][\w$]*)$/is.exec(trimmed);
  if (explicit) {
    return SQL_KEYWORD_SET.has(explicit[1].toUpperCase()) ? undefined : explicit[1];
  }
  // Implicit alias after a call: `count(*) total`.
  const implicit = /\)\s+([a-z_][\w$]*)$/i.exec(trimmed);
  if (implicit && !SQL_KEYWORD_SET.has(implicit[1].toUpperCase())) { return implicit[1]; }
  // Plain or qualified column (`u.id` → `id`).
  const identifier = /^(?:\w+\.)*([a-z_][\w$]*)$/i.exec(trimmed);
  if (identifier) { return identifier[1]; }
  // Bare call: `count(*)` → `count`.
  return /^([a-z_][\w$]*)\s*\(/i.exec(trimmed)?.[1];
}

function buildTableCompletionItems(schema: SchemaInfo): vscode.CompletionItem[] {
  return schema.tables.map(table => {
    const item = new vscode.CompletionItem(table.name, vscode.CompletionItemKind.Struct);
    item.detail = `Table${table.schema ? ` (${table.schema})` : ''} — ${table.columns.length} columns`;
    item.sortText = '0' + table.name;
    return item;
  });
}

/** A completion candidate column; `detail` is absent when no type metadata exists. */
interface CompletionColumn {
  name: string;
  detail?: string;
}

function buildColumnCompletionItems(schema: SchemaInfo, tableName: string): vscode.CompletionItem[] {
  const table = findTable(schema, tableName);
  if (!table) { return []; }

  return buildColumnItems(table.columns.map(col => ({
    name: col.name,
    detail: `${col.dataType}${col.nullable ? ' (nullable)' : ''}`,
  })));
}

/** Columns of a derived table carry no type metadata, only a name. */
function buildDerivedColumnCompletionItems(columns: string[]): vscode.CompletionItem[] {
  return buildColumnItems(columns.map(name => ({ name, detail: 'subquery' })));
}

function buildColumnItems(columns: CompletionColumn[]): vscode.CompletionItem[] {
  return columns.map(col => {
    const item = new vscode.CompletionItem(col.name, vscode.CompletionItemKind.Field);
    if (col.detail) { item.detail = col.detail; }
    item.sortText = '0' + col.name;
    return item;
  });
}
