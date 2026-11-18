import * as assert from 'assert';
import { createRequire } from 'node:module';
import type * as VSCode from 'vscode';
import { detectSqlRegions } from '../../src/detection/sqlDetector';

const requireModule = createRequire(__filename);
const loader = requireModule('node:module') as { _load: (name: string, ...args: unknown[]) => unknown };
const originalLoad = loader._load;

let diagnostics: Array<{ message: string }> = [];
let onActiveEditor: ((editor: { document: VSCode.TextDocument } | undefined) => void) | undefined;

const vscode = {
  Range: class { constructor(public start: unknown, public end: unknown) {} },
  Diagnostic: class {
    source?: string;
    constructor(public range: unknown, public message: string, public severity: number) {}
  },
  DiagnosticSeverity: { Warning: 1 },
  languages: {
    createDiagnosticCollection: () => ({
      set: (_uri: unknown, diags: Array<{ message: string }>) => { diagnostics = diags; },
      delete: () => { diagnostics = []; },
      clear: () => { diagnostics = []; },
      dispose() {},
    }),
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    onDidChangeTextDocument: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    onDidChangeActiveTextEditor: (listener: typeof onActiveEditor) => {
      onActiveEditor = listener;
      return { dispose() {} };
    },
  },
};

loader._load = (name, ...args) => {
  if (name === 'vscode') { return vscode; }
  if (name === '../configuration') {
    return {
      SUPPORTED_LANGUAGES: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'python', 'java', 'csharp', 'perl'],
      documentSqlRegions: (doc: { getText: () => string; languageId: string }) =>
        detectSqlRegions(doc.getText(), doc.languageId),
    };
  }
  return originalLoad(name, ...args);
};

let SqlDiagnosticsProvider: typeof import('../../src/validation/sqlDiagnosticsProvider').SqlDiagnosticsProvider;
try {
  ({ SqlDiagnosticsProvider } = requireModule('../../src/validation/sqlDiagnosticsProvider'));
} finally {
  loader._load = originalLoad;
}

function validatePerl(source: string): Array<{ message: string }> {
  diagnostics = [];
  const provider = new SqlDiagnosticsProvider();
  try {
    const document = {
      uri: { toString: () => 'file:///query.pl' },
      languageId: 'perl',
      getText: () => source,
      positionAt: (offset: number) => ({ line: 0, character: offset }),
    } as unknown as VSCode.TextDocument;
    onActiveEditor?.({ document });
    return diagnostics;
  } finally {
    provider.dispose();
  }
}

describe('Perl SQL validation', () => {
  it('validates dynamic Perl SQL with interpolated prefixes, table qualifiers, and aliases without false warnings', () => {
    const source = [
      'my $q1 = "SELECT $alias.id, ${prefix}_name FROM $db.$table WHERE id IN ($ids->@*)";',
      'my $q2 = <<~SQL;',
      '    SELECT u.id, u.email',
      '    FROM ${tenant}_users u',
      '    WHERE u.id = $params->{id}',
      '    SQL',
    ].join('\n');
    assert.deepStrictEqual(validatePerl(source), []);
  });

  it('reports syntax warnings for malformed SQL inside Perl literals', () => {
    const diags = validatePerl('my $bad = "SELECT id FROM";');
    assert.strictEqual(diags.length, 1);
    assert.ok(diags[0].message.startsWith('SQL:'));
  });
});
