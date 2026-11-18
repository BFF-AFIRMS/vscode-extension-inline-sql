import * as vscode from 'vscode';
import { DbConnectionConfig, SchemaInfo, TableInfo } from '../types';

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { SchemaCache } from './schemaCache';

/** Whitelist of allowed database driver modules */
const ALLOWED_DRIVER_MODULES = new Set(['pg', 'mysql2/promise', 'mssql']);

/** Why a driver could not be loaded, as opposed to a query failing. */
export type DriverLoadReason = 'untrusted' | 'not-allowed' | 'not-installed';

/** Raised when a driver module cannot be located or loaded. Never carries credentials. */
export class DriverLoadError extends Error {
  constructor(
    readonly reason: DriverLoadReason,
    readonly moduleName: string,
    message: string,
    readonly searched: readonly string[] = [],
  ) {
    super(message);
    this.name = 'DriverLoadError';
  }
}

/** A directory to resolve drivers from; `direct` roots contain the packages themselves. */
interface DriverRoot {
  dir: string;
  direct: boolean;
}

/** `createRequire` resolves as if importing from inside `dir`, so `dir/node_modules` is searched. */
function requireFrom(dir: string): NodeJS.Require {
  return createRequire(path.join(dir, 'package.json'));
}

/**
 * Directories to resolve drivers from, most specific first: workspace folders, then
 * `NODE_PATH` entries, then the Node installation's own package directory (which is
 * where `npm install -g` puts them).
 */
function driverRoots(): DriverRoot[] {
  const roots: DriverRoot[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme === 'file') { roots.push({ dir: folder.uri.fsPath, direct: false }); }
  }
  for (const entry of (process.env.NODE_PATH ?? '').split(path.delimiter)) {
    if (entry) { roots.push({ dir: entry, direct: true }); }
  }
  // `<prefix>/lib/node_modules` on POSIX, `<prefix>/node_modules` on Windows.
  const prefix = path.dirname(path.dirname(process.execPath));
  roots.push({
    dir: process.platform === 'win32'
      ? path.join(prefix, 'node_modules')
      : path.join(prefix, 'lib', 'node_modules'),
    direct: true,
  });
  const seen = new Set<string>();
  return roots.filter(root => {
    if (seen.has(root.dir)) { return false; }
    seen.add(root.dir);
    return true;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lazyRequire(moduleName: string): any {
  if (!ALLOWED_DRIVER_MODULES.has(moduleName)) {
    throw new DriverLoadError('not-allowed', moduleName, `Driver module "${moduleName}" is not in the allowed list.`);
  }
  if (!vscode.workspace.isTrusted) {
    throw new DriverLoadError('untrusted', moduleName, 'Database drivers require a trusted workspace.');
  }
  const searched: string[] = [];
  for (const root of driverRoots()) {
    if (!existsSync(root.dir)) { continue; }
    searched.push(root.dir);
    const loader = requireFrom(root.dir);
    let resolved: string;
    if (root.direct) {
      // Direct roots hold packages; resolve the subpath from inside the package directory.
      const pkgName = moduleName.split('/')[0];
      const pkgDir = path.join(root.dir, pkgName);
      if (!existsSync(pkgDir)) { continue; }
      try { resolved = createRequire(path.join(pkgDir, 'noop.js')).resolve(`.${moduleName.slice(pkgName.length)}`); }
      catch { continue; }
    } else {
      try { resolved = loader.resolve(moduleName); }
      catch { continue; }
    }
    return loader(resolved);
  }
  throw new DriverLoadError(
    'not-installed',
    moduleName,
    `Install ${moduleName.split('/')[0]} in a trusted workspace to use schema completion.`,
    searched,
  );
}

/** User-facing description of a failed driver load (contains no credentials). */
export function driverLoadMessage(error: DriverLoadError): string {
  const pkg = error.moduleName.split('/')[0];
  switch (error.reason) {
    case 'untrusted':
      return `Inline SQL: Database drivers require a trusted workspace. Trust this folder to load "${pkg}" schema completion.`;
    case 'not-installed':
      return `Inline SQL: The "${pkg}" driver is not installed. Run "npm install ${pkg}" in a workspace folder (or "npm i -g ${pkg}"), then run "Inline SQL: Refresh Schema Cache". See Output → Inline SQL.`;
    default:
      return `Inline SQL: ${error.message}`;
  }
}

/** Extract a driver error code (SQLSTATE or errno) for display; codes never contain credentials. */
function readErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : undefined;
}

/**
 * Driver and network errors can embed host names, user names and credentials.
 * Redact known secrets before anything reaches the log.
 */
function redact(message: string, secrets: Array<string | undefined>): string {
  let result = message;
  for (const secret of secrets) {
    if (secret) { result = result.split(secret).join('***'); }
  }
  return result.replace(/\b(password|passwd|pwd|secret|token)\s*[=:]\s*\S+/gi, '$1=***');
}

function describeTarget(config: DbConnectionConfig): string {
  return `${config.driver}://${config.host}:${config.port ?? '?'}/${config.database}`;
}

/** Connection timeout in milliseconds */
const CONNECTION_TIMEOUT_MS = 10000;

/** Backoff before retrying after a failure, so repeated triggers do not spam errors. */
const RETRY_BACKOFF_MS = 30000;

export class ConnectionManager implements vscode.Disposable {
  private schemaCache: SchemaCache;
  private output: vscode.OutputChannel;
  private disposables: vscode.Disposable[] = [];
  private passwordWarningShown = false;
  private generation = 0;
  private nextRetryTime = 0;
  private disposed = false;
  private pendingSchemaFetch: Promise<SchemaInfo | undefined> | null = null;

  constructor() {
    this.output = vscode.window.createOutputChannel('Inline SQL');
    this.disposables.push(this.output);

    const config = vscode.workspace.getConfiguration('inlineSql');
    const ttl = clampTTL(config.get<number>('schemaCacheTTL', 300));
    this.schemaCache = new SchemaCache(ttl);

    // Listen for config changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('inlineSql.schemaCacheTTL')) {
          const newTTL = clampTTL(
            vscode.workspace.getConfiguration('inlineSql').get<number>('schemaCacheTTL', 300)
          );
          this.schemaCache.setTTL(newTTL);
        }
        if (e.affectsConfiguration('inlineSql.connections') || e.affectsConfiguration('inlineSql.activeConnection')) {
          this.invalidate();
        }
      })
    );
  }

  getActiveConnectionConfig(): DbConnectionConfig | undefined {
    if (this.disposed || !vscode.workspace.isTrusted) { return undefined; }
    const config = vscode.workspace.getConfiguration('inlineSql');
    const connections = config.get<DbConnectionConfig[]>('connections', []);
    const activeName = config.get<string>('activeConnection', '');

    if (!activeName || !Array.isArray(connections) || connections.length === 0) {
      return undefined;
    }

    const conn = connections.find(c => c && c.name === activeName);
    if (!conn || !['postgres', 'mysql', 'mssql'].includes(conn.driver) ||
        typeof conn.host !== 'string' || !conn.host ||
        typeof conn.database !== 'string' || !conn.database ||
        (conn.user !== undefined && typeof conn.user !== 'string') ||
        (conn.password !== undefined && typeof conn.password !== 'string') ||
        (conn.passwordEnv !== undefined && (typeof conn.passwordEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(conn.passwordEnv)))) {
      return undefined;
    }

    // Validate host format (basic sanity check)
    if (conn.host && !/^[\w.\-:[\]]+$/.test(conn.host)) {
      vscode.window.showErrorMessage('Inline SQL: Invalid host format in connection configuration.');
      return undefined;
    }

    // Validate port range
    if (conn.port !== undefined && (conn.port < 1 || conn.port > 65535 || !Number.isInteger(conn.port))) {
      vscode.window.showErrorMessage('Inline SQL: Invalid port in connection configuration (must be 1-65535).');
      return undefined;
    }

    // Warn once if password is stored in plaintext settings
    if (conn.password && !this.passwordWarningShown) {
      this.passwordWarningShown = true;
      vscode.window.showWarningMessage(
        'Inline SQL: Database password is stored in plaintext in settings.json. ' +
        'Use the passwordEnv setting to read an environment variable instead.'
      );
    }

    if (conn.passwordEnv && process.env[conn.passwordEnv] === undefined) {
      return undefined;
    }
    return { ...conn, password: conn.passwordEnv ? process.env[conn.passwordEnv] : conn.password };
  }

  async getSchema(): Promise<SchemaInfo | undefined> {
    const connConfig = this.getActiveConnectionConfig();
    if (!connConfig) { return undefined; }

    // Check cache
    const cached = this.schemaCache.get(connConfig.name);
    if (cached) { return cached; }

    if (Date.now() < this.nextRetryTime) {
      this.log(`Skipping schema fetch for "${connConfig.name}": retrying in ${Math.ceil((this.nextRetryTime - Date.now()) / 1000)}s after a failed attempt.`);
      return undefined;
    }

    // Deduplicate concurrent fetches — use a stable reference
    if (this.pendingSchemaFetch) {
      return this.pendingSchemaFetch;
    }

    const fetchPromise = this.doFetchSchema(connConfig, this.generation);
    this.pendingSchemaFetch = fetchPromise;

    // Clear pending reference only if it's still the same promise (prevents race)
    fetchPromise.finally(() => {
      if (this.pendingSchemaFetch === fetchPromise) {
        this.pendingSchemaFetch = null;
      }
    });

    return fetchPromise;
  }

  private async doFetchSchema(connConfig: DbConnectionConfig, generation: number): Promise<SchemaInfo | undefined> {
    try {
      const schema = await this.fetchSchema(connConfig);
      if (this.disposed || generation !== this.generation) {
        this.log(`Discarded schema for "${connConfig.name}": configuration changed during the fetch.`);
        return undefined;
      }
      if (schema) {
        this.schemaCache.set(connConfig.name, schema);
        this.log(`Loaded ${schema.tables.length} table(s) for "${connConfig.name}" from ${describeTarget(connConfig)}.`);
      }
      return schema;
    } catch (err) {
      if (this.disposed || generation !== this.generation) {
        this.log(`Discarded schema error for "${connConfig.name}": configuration changed during the fetch.`);
        return undefined;
      }
      this.nextRetryTime = Date.now() + RETRY_BACKOFF_MS;
      if (err instanceof DriverLoadError) {
        this.log(`Driver "${err.moduleName}" unavailable for "${connConfig.name}" (${err.reason}); searched: ${err.searched.length ? err.searched.join(', ') : 'no directories'}.`);
        vscode.window.showErrorMessage(driverLoadMessage(err));
        return undefined;
      }
      const code = readErrorCode(err);
      const detail = err instanceof Error ? err.message : String(err);
      const secrets = [connConfig.password, connConfig.passwordEnv ? process.env[connConfig.passwordEnv] : undefined];
      this.log(`Schema fetch failed for "${connConfig.name}" (${describeTarget(connConfig)})${code ? ` [${code}]` : ''}: ${redact(detail, secrets)}`);
      vscode.window.showErrorMessage(
        `Inline SQL: Failed to fetch schema for "${connConfig.name}"${code ? ` [${code}]` : ''}. Check the connection settings, credentials and network access. Details in Output → Inline SQL.`,
      );
      return undefined;
    }
  }

  getSchemaSync(): SchemaInfo | undefined {
    const connConfig = this.getActiveConnectionConfig();
    if (!connConfig) { return undefined; }
    return this.schemaCache.get(connConfig.name);
  }

  async refreshSchema(): Promise<void> {
    this.invalidate();
    const schema = await this.getSchema();
    if (schema) {
      vscode.window.showInformationMessage(
        `Inline SQL: Schema refreshed — ${schema.tables.length} tables loaded.`
      );
    }
  }

  private async fetchSchema(config: DbConnectionConfig): Promise<SchemaInfo | undefined> {
    switch (config.driver) {
      case 'postgres':
        return this.fetchPostgresSchema(config);
      case 'mysql':
        return this.fetchMysqlSchema(config);
      case 'mssql':
        return this.fetchMssqlSchema(config);
      default:
        return undefined;
    }
  }

  private async fetchPostgresSchema(config: DbConnectionConfig): Promise<SchemaInfo> {
    const pg = lazyRequire('pg');
    const client = new pg.Client({
      host: config.host,
      port: config.port || 5432,
      database: config.database,
      user: config.user,
      password: config.password,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      query_timeout: CONNECTION_TIMEOUT_MS,
    });

    try {
      await client.connect();
      const result = await client.query(`
        SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON c.table_schema = t.table_schema AND c.table_name = t.table_name
        WHERE t.table_type = 'BASE TABLE'
          AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY c.table_schema, c.table_name, c.ordinal_position
      `);

      return buildSchemaFromRows(result.rows, 'table_schema', 'table_name', 'column_name', 'data_type', 'is_nullable');
    } finally {
      await client.end().catch(() => { /* ignore cleanup error */ });
    }
  }

  private async fetchMysqlSchema(config: DbConnectionConfig): Promise<SchemaInfo> {
    const mysql = lazyRequire('mysql2/promise');
    const connection = await mysql.createConnection({
      host: config.host,
      port: config.port || 3306,
      database: config.database,
      user: config.user,
      password: config.password,
      connectTimeout: CONNECTION_TIMEOUT_MS,
    });

    try {
      const [rows] = await connection.execute(`
        SELECT table_schema AS TABLE_SCHEMA, table_name AS TABLE_NAME, column_name AS COLUMN_NAME,
               data_type AS DATA_TYPE, is_nullable AS IS_NULLABLE
        FROM information_schema.columns
        WHERE table_schema = ?
        ORDER BY table_name, ordinal_position
      `, [config.database]);

      return buildSchemaFromRows(rows as Record<string, string>[], 'TABLE_SCHEMA', 'TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE', 'IS_NULLABLE');
    } finally {
      await connection.end().catch(() => { /* ignore cleanup error */ });
    }
  }

  private async fetchMssqlSchema(config: DbConnectionConfig): Promise<SchemaInfo> {
    const mssql = lazyRequire('mssql');
    const pool = new mssql.ConnectionPool({
      server: config.host,
      port: config.port || 1433,
      database: config.database,
      user: config.user,
      password: config.password,
      options: { encrypt: true, trustServerCertificate: false },
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      requestTimeout: CONNECTION_TIMEOUT_MS,
    });

    try {
      await pool.connect();
      const result = await pool.request().query(`
        SELECT s.name AS table_schema, t.name AS table_name, c.name AS column_name,
               ty.name AS data_type, c.is_nullable
        FROM sys.columns c
        JOIN sys.tables t ON c.object_id = t.object_id
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        JOIN sys.types ty ON c.user_type_id = ty.user_type_id
        ORDER BY s.name, t.name, c.column_id
      `);

      return buildSchemaFromRows(result.recordset, 'table_schema', 'table_name', 'column_name', 'data_type', 'is_nullable');
    } finally {
      await pool.close().catch(() => { /* ignore cleanup error */ });
    }
  }

  private invalidate(): void {
    this.generation++;
    this.nextRetryTime = 0;
    this.pendingSchemaFetch = null;
    this.schemaCache.invalidate();
  }

  private log(message: string): void {
    if (this.disposed) { return; }
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
    this.disposables.forEach(d => d.dispose());
  }
}

/** Clamp TTL to a valid range: 1–86400 seconds (1 second to 24 hours) */
function clampTTL(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(Math.floor(value), 86400)) : 300;
}

export function buildSchemaFromRows(
  rows: Record<string, unknown>[],
  schemaCol: string, tableCol: string, columnCol: string, typeCol: string, nullableCol: string
): SchemaInfo {
  const tableMap = new Map<string, TableInfo>();

  for (const row of rows) {
    // Skip rows with missing required columns
    if (row[tableCol] == null || row[columnCol] == null || row[typeCol] == null) {
      continue;
    }

    const tableName = String(row[tableCol]);
    const key = JSON.stringify([row[schemaCol] ?? null, tableName]);

    if (!tableMap.has(key)) {
      tableMap.set(key, {
        name: tableName,
        schema: row[schemaCol] != null ? String(row[schemaCol]) : undefined,
        columns: [],
      });
    }

    const table = tableMap.get(key)!;
    table.columns.push({
      name: String(row[columnCol]),
      dataType: String(row[typeCol]),
      nullable: String(row[nullableCol]).toUpperCase() === 'YES' || row[nullableCol] === true || row[nullableCol] === 1,
    });
  }

  return {
    tables: Array.from(tableMap.values()),
    lastUpdated: Date.now(),
  };
}
