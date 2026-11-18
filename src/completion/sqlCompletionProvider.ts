import * as vscode from 'vscode';
import { findSqlRegionAtOffset } from '../detection/sqlDetector';
import { documentSqlRegions } from '../configuration';
import { buildCompletionItems } from './sqlKeywords';
import { SchemaInfo } from '../types';
import {
  SQL_KEYWORD_SET,
  extractDerivedTables,
  extractReferencedTables,
  findTable,
  resolveTableReference,
} from '../analysis/sqlReferences';

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

function getTableNameBeforeDot(sqlBefore: string): string | undefined {
  const match = sqlBefore.trimEnd().match(/(\w+)\.\s*$/);
  if (!match) { return undefined; }
  const name = match[1];
  // Skip SQL keywords that happen to precede a dot
  if (SQL_KEYWORD_SET.has(name.toUpperCase())) { return undefined; }
  return name;
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
