import * as assert from 'assert';
import { createRequire } from 'node:module';
import type * as VSCode from 'vscode';
import type { SchemaInfo } from '../../src/types';

const requireModule = createRequire(__filename);
const loader = requireModule('node:module') as { _load: (name: string, ...args: unknown[]) => unknown };
const originalLoad = loader._load;
const settings: Record<string, unknown> = {};
const vscode = {
  workspace: { getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback }) },
  MarkdownString: class {
    value = '';
    appendMarkdown(text: string): this { this.value += text; return this; }
  },
  Hover: class { constructor(public contents: VSCode.MarkdownString) {} },
  Range: class { constructor(public start: unknown, public end: unknown) {} },
};
loader._load = (name, ...args) => name === 'vscode' ? vscode : originalLoad(name, ...args);
let hover: typeof import('../../src/hover/sqlHoverProvider');
try { hover = requireModule('../../src/hover/sqlHoverProvider'); }
finally { loader._load = originalLoad; }

const schema: SchemaInfo = {
  tables: [{
    name: 'users',
    schema: 'public',
    columns: [
      { name: 'id', dataType: 'integer', nullable: false },
      { name: 'email', dataType: 'varchar(255)', nullable: true },
    ],
  }],
  lastUpdated: 0,
};

function makeDocument(source: string): VSCode.TextDocument {
  return {
    languageId: 'typescript',
    getText: () => source,
    offsetAt: (position: VSCode.Position) => position.character,
    positionAt: (offset: number) => ({ line: 0, character: offset }),
  } as unknown as VSCode.TextDocument;
}

async function hoverAt(
  provider: InstanceType<typeof hover.SqlHoverProvider>,
  source: string,
  needle: string
): Promise<string> {
  const character = source.indexOf(needle) + Math.floor(needle.length / 2);
  const result = await provider.provideHover(
    makeDocument(source),
    { character } as VSCode.Position,
    { isCancellationRequested: false } as VSCode.CancellationToken
  );
  if (!result) { return ''; }
  return (result.contents as unknown as { value: string }).value;
}

describe('SQL hover documentation', () => {
  it('shows the type of the column under the cursor', async () => {
    const provider = new hover.SqlHoverProvider(() => schema);
    const text = await hoverAt(provider, 'const q = "SELECT u.email FROM users u";', 'email');
    assert.ok(text.includes('varchar(255)'), text);
    assert.ok(text.includes('nullable'), text);
    assert.ok(text.includes('public'), text);
  });

  it('shows every column of the table under the cursor', async () => {
    const provider = new hover.SqlHoverProvider(() => schema);
    const text = await hoverAt(provider, 'const q = "SELECT u.email FROM users u";', 'users');
    assert.ok(text.includes('integer'), text);
    assert.ok(text.includes('varchar(255)'), text);
  });

  it('resolves an alias to the table it stands for', async () => {
    const provider = new hover.SqlHoverProvider(() => schema);
    const text = await hoverAt(provider, 'const q = "SELECT u.email FROM users u";', 'u');
    assert.ok(text.includes('varchar(255)'), text);
    assert.ok(text.includes('users'), text);
  });

  it('describes a subquery alias without a database connection', async () => {
    const source = 'const q = "SELECT * FROM (SELECT subject_id AS subplot_id, object_id AS parent_id FROM stock_relationship) AS pairs";';
    const text = await hoverAt(new hover.SqlHoverProvider(), source, 'pairs');
    assert.ok(text.includes('subplot_id'), text);
    assert.ok(text.includes('parent_id'), text);
  });

  it('shows nothing outside a SQL region or inside a SQL string literal', async () => {
    const provider = new hover.SqlHoverProvider(() => schema);
    assert.strictEqual(await hoverAt(provider, 'const message = "users";', 'users'), '');
    assert.strictEqual(await hoverAt(provider, 'const q = "SELECT \'users\' FROM users";', 'users'), '');
  });
});
