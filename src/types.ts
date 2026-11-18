export interface SqlRegion {
  /** Document offset where SQL content begins (inside the string delimiter) */
  startOffset: number;
  /** Document offset where SQL content ends (before the closing string delimiter) */
  endOffset: number;
  /** The raw SQL text with interpolations replaced by placeholders */
  sqlText: string;
  /** The host language ID */
  languageId: string;
  /** Original literal metadata; normalized sqlText must never be written to source. */
  literal?: StringLiteral;
}

export interface StringLiteral {
  /** Document offset where the string content begins (after opening delimiter) */
  contentStart: number;
  /** Document offset where the string content ends (before closing delimiter) */
  contentEnd: number;
  /** The raw string content */
  content: string;
  /** Type of string literal */
  type: 'single' | 'double' | 'template' | 'triple' | 'verbatim' | 'raw' | 'textblock' | 'heredoc';
  interpolationWidth?: number;
  raw?: boolean;
  /** Leading indentation of a heredoc's closing delimiter (e.g. Perl <<~SQL) */
  closingIndent?: string;
}

export interface DbConnectionConfig {
  name: string;
  driver: 'postgres' | 'mysql' | 'mssql';
  host: string;
  port?: number;
  database: string;
  user?: string;
  password?: string;
  passwordEnv?: string;
  ssl?: boolean | DbSslConfig;
}

/** TLS options forwarded to `tls.connect`; only the fields the extension validates. */
export interface DbSslConfig {
  /** Verify the server certificate chain; set to false only for self-signed development servers. */
  rejectUnauthorized?: boolean;
  /** PEM-encoded CA certificate(s) to trust. */
  ca?: string;
  /** PEM-encoded client certificate (mutual TLS). */
  cert?: string;
  /** PEM-encoded client private key (mutual TLS). */
  key?: string;
  /** SNI hostname; defaults to the connection host. */
  servername?: string;
}

export interface SchemaInfo {
  tables: TableInfo[];
  lastUpdated: number;
}

export interface TableInfo {
  name: string;
  schema?: string;
  columns: ColumnInfo[];
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
}
