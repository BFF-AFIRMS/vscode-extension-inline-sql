import * as vscode from 'vscode';
import { documentSqlRegions } from '../configuration';
import { findSqlRegionAtOffset } from '../detection/sqlDetector';
import { SchemaInfo, TableInfo } from '../types';
import {
  extractDerivedTables,
  extractReferencedTables,
  extractTableReferences,
  findTable,
  maskSqlLiterals,
  resolveTableReference,
} from '../analysis/sqlReferences';

/** Maximum columns listed for one table; the remainder is summarized. */
const MAX_HOVER_COLUMNS = 30;

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;
const IDENTIFIER_START = /[A-Za-z_]/;

/** A column as hover renders it; type and nullability are absent for derived tables. */
interface HoverColumn {
  name: string;
  dataType?: string;
  nullable?: boolean;
}

/** The identifier under the cursor together with the qualifiers in front of it. */
interface WordAtCursor {
  word: string;
  /** Dot-separated qualifiers, outermost first (`db.schema.table` → [`db`, `schema`]). */
  qualifiers: string[];
  /** Offsets of the word within the SQL region. */
  start: number;
  end: number;
}

export class SqlHoverProvider implements vscode.HoverProvider {
  private schemaProvider: (() => SchemaInfo | undefined | Promise<SchemaInfo | undefined>) | undefined;

  constructor(schemaProvider?: () => SchemaInfo | undefined | Promise<SchemaInfo | undefined>) {
    this.schemaProvider = schemaProvider;
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    const offset = document.offsetAt(position);
    const region = findSqlRegionAtOffset(documentSqlRegions(document), offset);
    if (!region) {
      return undefined;
    }

    const sql = document.getText().slice(region.startOffset, region.endOffset);
    const located = identifierAt(sql, offset - region.startOffset);
    if (!located) {
      return undefined;
    }

    const markdown = await this.describe(sql, located, token);
    if (!markdown) {
      return undefined;
    }

    const range = new vscode.Range(
      document.positionAt(region.startOffset + located.start),
      document.positionAt(region.startOffset + located.end)
    );
    return new vscode.Hover(markdown, range);
  }

  private async describe(
    sql: string,
    located: WordAtCursor,
    token: vscode.CancellationToken
  ): Promise<vscode.MarkdownString | undefined> {
    const { word, qualifiers } = located;
    const lower = word.toLowerCase();
    const derived = extractDerivedTables(sql);

    // A subquery is described by the SQL text itself, so its columns need no connection.
    const projected = derived.get(lower);
    if (projected) {
      return renderTable(
        word,
        `columns projected by the subquery \`${word}\` (${projected.length})`,
        projected.map(name => ({ name }))
      );
    }

    const qualifier = qualifiers[qualifiers.length - 1];
    const derivedColumns = qualifier ? derived.get(qualifier.toLowerCase()) : undefined;
    if (derivedColumns && derivedColumns.some(name => name.toLowerCase() === lower)) {
      return renderColumn(word, { name: word }, `subquery \`${qualifier}\``);
    }

    const schema = await this.schemaProvider?.();
    if (token.isCancellationRequested || !schema) {
      return undefined;
    }

    const references = extractTableReferences(sql);
    const reference = references.find(r => r.alias?.toLowerCase() === lower)
      ?? references.find(r => r.table.split('.').pop()?.toLowerCase() === lower);
    if (reference) {
      const table = findTable(schema, reference.table);
      return table ? renderTable(table.name, tableSubtitle(table), table.columns) : undefined;
    }

    if (qualifier) {
      const table = findTable(schema, resolveTableReference(qualifier, sql));
      const column = table?.columns.find(c => c.name.toLowerCase() === lower);
      return table && column ? renderColumn(word, column, tableLabel(table)) : undefined;
    }

    // Unqualified column: report the first referenced table that has it.
    for (const table of extractReferencedTables(sql, schema)) {
      const column = table.columns.find(c => c.name.toLowerCase() === lower);
      if (column) {
        return renderColumn(word, column, tableLabel(table));
      }
    }
    return undefined;
  }
}

/**
 * Locate the identifier at `offset`, with the qualifiers that precede it.
 * Identifiers inside string literals or comments are ignored, as are multi-character
 * operators and punctuation.
 */
function identifierAt(sql: string, offset: number): WordAtCursor | undefined {
  let start = offset;
  while (start > 0 && IDENTIFIER_CHAR.test(sql[start - 1])) { start--; }
  let end = offset;
  while (end < sql.length && IDENTIFIER_CHAR.test(sql[end])) { end++; }
  const word = sql.slice(start, end);
  if (!word || !IDENTIFIER_START.test(word[0])) { return undefined; }
  // The mask keeps offsets, so a blanked-out word is a literal or a comment.
  if (maskSqlLiterals(sql).slice(start, end) !== word) { return undefined; }

  const qualifiers: string[] = [];
  let cursor = start;
  for (;;) {
    let dot = cursor - 1;
    while (dot >= 0 && (sql[dot] === ' ' || sql[dot] === '\t')) { dot--; }
    if (dot < 0 || sql[dot] !== '.') { break; }
    let nameStart = dot;
    while (nameStart > 0 && IDENTIFIER_CHAR.test(sql[nameStart - 1])) { nameStart--; }
    const qualifier = sql.slice(nameStart, dot);
    if (!qualifier || !IDENTIFIER_START.test(qualifier[0])) { break; }
    qualifiers.unshift(qualifier);
    cursor = nameStart;
  }
  return { word, qualifiers, start, end };
}

/** Render a table as a header plus one row per column. */
function renderTable(name: string, subtitle: string, columns: HoverColumn[]): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**\`${name}\`** — ${subtitle}\n\n`);
  if (columns.length === 0) {
    return markdown;
  }
  markdown.appendMarkdown('| Column | Type | Nullable |\n| --- | --- | --- |\n');
  for (const column of columns.slice(0, MAX_HOVER_COLUMNS)) {
    const type = column.dataType ? `\`${column.dataType}\`` : 'unknown';
    markdown.appendMarkdown(`| \`${column.name}\` | ${type} | ${nullableLabel(column)} |\n`);
  }
  if (columns.length > MAX_HOVER_COLUMNS) {
    markdown.appendMarkdown(`\n${columns.length - MAX_HOVER_COLUMNS} more column(s) not shown.\n`);
  }
  return markdown;
}

/** Render a single column with its type, nullability and owning table. */
function renderColumn(name: string, column: HoverColumn, owner: string): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  const type = column.dataType ? `\`${column.dataType}\`` : 'unknown type';
  const nullable = column.nullable === undefined ? '' : column.nullable ? ', nullable' : ', not null';
  markdown.appendMarkdown(`**\`${name}\`** — ${type}${nullable}\n\nColumn of ${owner}.`);
  return markdown;
}

function nullableLabel(column: HoverColumn): string {
  if (column.nullable === undefined) { return '—'; }
  return column.nullable ? 'yes' : 'no';
}

function tableSubtitle(table: TableInfo): string {
  const count = `${table.columns.length} column${table.columns.length === 1 ? '' : 's'}`;
  return table.schema ? `table in schema \`${table.schema}\`, ${count}` : `table, ${count}`;
}

function tableLabel(table: TableInfo): string {
  return table.schema ? `\`${table.schema}\`.\`${table.name}\`` : `\`${table.name}\``;
}
