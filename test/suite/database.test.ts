import * as assert from 'assert';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectionManager as Manager } from '../../src/db/connectionManager';
import type { SchemaInfo } from '../../src/types';

const requireModule = createRequire(__filename);
const loader = requireModule('node:module') as { _load: (name: string, ...args: unknown[]) => unknown };
const originalLoad = loader._load;
let settings: Record<string, unknown>;
let change: (event: { affectsConfiguration: (name: string) => boolean }) => void;
const errors: string[] = [];
const logs: string[] = [];
const vscode = {
  workspace: {
    isTrusted: true,
    workspaceFolders: [] as Array<{ uri: { scheme: string; fsPath: string } }>,
    getConfiguration: () => ({ get: (name: string, fallback: unknown) => settings[name] ?? fallback }),
    onDidChangeConfiguration: (listener: typeof change) => { change = listener; return { dispose() {} }; },
  },
  window: {
    createOutputChannel: () => ({ appendLine: (line: string) => { logs.push(line); }, dispose() {} }),
    showErrorMessage: (message: string) => errors.push(message),
    showWarningMessage() {}, showInformationMessage() {},
  },
};
loader._load = (name, ...args) => name === 'vscode' ? vscode : originalLoad(name, ...args);
let db: typeof import('../../src/db/connectionManager');
try { db = requireModule('../../src/db/connectionManager'); }
finally { loader._load = originalLoad; }

describe('Database security and cache isolation', () => {
  let manager: Manager;
  beforeEach(() => {
    settings = { connections: [{ name: 'test', driver: 'postgres', host: 'localhost', database: 'test' }], activeConnection: 'test' };
    vscode.workspace.isTrusted = true;
    errors.length = 0;
    logs.length = 0;
    manager = new db.ConnectionManager();
  });
  afterEach(() => manager.dispose());

  it('never fetches a database schema in an untrusted workspace', async () => {
    vscode.workspace.isTrusted = false;
    Object.assign(manager, { fetchSchema: () => assert.fail('Network access must be blocked') });
    assert.strictEqual(manager.getActiveConnectionConfig(), undefined);
    assert.strictEqual(await manager.getSchema(), undefined);
  });

  it('rejects malformed connection settings', () => {
    for (const connections of [null, 'invalid', [null], [{ name: 'test', driver: 'postgres', database: 'db' }]]) {
      settings.connections = connections;
      assert.strictEqual(manager.getActiveConnectionConfig(), undefined);
    }
  });

  it('deduplicates requests but discards results after a configuration change', async () => {
    let resolveOld!: (value: SchemaInfo) => void;
    let calls = 0;
    Object.assign(manager, { fetchSchema: () => {
      calls++;
      return calls === 1 ? new Promise<SchemaInfo>(resolve => { resolveOld = resolve; }) : Promise.resolve({ tables: [], lastUpdated: Date.now() });
    } });
    const first = manager.getSchema();
    const duplicate = manager.getSchema();
    assert.strictEqual(calls, 1);
    change({ affectsConfiguration: name => name === 'inlineSql.connections' });
    const fresh = await manager.getSchema();
    resolveOld({ tables: [{ name: 'stale', columns: [] }], lastUpdated: Date.now() });
    assert.strictEqual(await first, undefined);
    assert.strictEqual(await duplicate, undefined);
    assert.strictEqual(calls, 2);
    assert.strictEqual(manager.getSchemaSync(), fresh);
  });

  it('does not expose driver errors containing passwords', async () => {
    Object.assign(manager, { fetchSchema: async () => { throw new Error('password=super-secret'); } });
    assert.strictEqual(await manager.getSchema(), undefined);
    assert.strictEqual(errors.length, 1);
    assert.ok(!errors[0].includes('super-secret'));
  });

  it('keeps tables with the same name in separate schemas', () => {
    const result = db.buildSchemaFromRows([
      { schema: 'public', table: 'users', column: 'id', type: 'int', nullable: 'NO' },
      { schema: 'private', table: 'users', column: 'secret', type: 'text', nullable: true },
    ], 'schema', 'table', 'column', 'type', 'nullable');
    assert.strictEqual(result.tables.length, 2);
    assert.deepStrictEqual(result.tables.map(t => t.columns[0].name), ['id', 'secret']);
  });

  it('loads the optional driver from a trusted workspace and closes it once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inline-sql-driver-'));
    const driver = join(root, 'node_modules/pg');
    mkdirSync(driver, { recursive: true });
    writeFileSync(join(driver, 'index.js'), `
      exports.closed = 0;
      exports.Client = class {
        async connect() {}
        async query() { return { rows: [{table_schema:'public',table_name:'users',column_name:'id',data_type:'int',is_nullable:'NO'}] }; }
        async end() { exports.closed++; }
      };
    `);
    vscode.workspace.workspaceFolders = [{ uri: { scheme: 'file', fsPath: root } }];
    try {
      const schema = await manager.getSchema();
      assert.strictEqual(schema?.tables[0].name, 'users');
      assert.strictEqual(requireModule(join(driver, 'index.js')).closed, 1);
    } finally {
      vscode.workspace.workspaceFolders = [];
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports missing drivers separately from connection failures', () => {
    const missing = db.driverLoadMessage(new db.DriverLoadError('not-installed', 'mysql2/promise', 'x', ['/ws']));
    assert.ok(missing.includes('"mysql2"'), missing);
    assert.ok(missing.includes('npm install mysql2'), missing);
    const untrusted = db.driverLoadMessage(new db.DriverLoadError('untrusted', 'pg', 'x'));
    assert.ok(untrusted.includes('trusted'), untrusted);
  });

  it('resolves globally installed drivers from NODE_PATH', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inline-sql-global-'));
    const driver = join(root, 'pg');
    mkdirSync(driver, { recursive: true });
    writeFileSync(join(driver, 'package.json'), '{"name":"pg","main":"index.js"}');
    writeFileSync(join(driver, 'index.js'), `
      exports.Client = class {
        async connect() {}
        async query() { return { rows: [{table_schema:'public',table_name:'global_users',column_name:'id',data_type:'int',is_nullable:'NO'}] }; }
        async end() {}
      };
    `);
    const previous = process.env.NODE_PATH;
    process.env.NODE_PATH = root;
    vscode.workspace.workspaceFolders = [];
    try {
      const schema = await manager.getSchema();
      assert.strictEqual(schema?.tables[0].name, 'global_users');
      assert.ok(logs.some(line => line.includes('Loaded 1 table(s)')), logs.join('\n'));
    } finally {
      if (previous === undefined) { delete process.env.NODE_PATH; } else { process.env.NODE_PATH = previous; }
      vscode.workspace.workspaceFolders = [];
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('logs failure codes and redacts the configured password', async () => {
    settings.connections = [{ name: 'test', driver: 'postgres', host: 'localhost', database: 'test', password: 'super-secret' }];
    Object.assign(manager, {
      fetchSchema: async () => { throw Object.assign(new Error('auth failed: password=super-secret'), { code: '28P01' }); },
    });
    assert.strictEqual(await manager.getSchema(), undefined);
    const output = logs.join('\n');
    assert.ok(!output.includes('super-secret'), output);
    assert.ok(output.includes('[28P01]'), output);
    assert.ok(errors[0].includes('28P01'), errors[0]);
    assert.ok(errors[0].includes('"test"'), errors[0]);
  });
});
