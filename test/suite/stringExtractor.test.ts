import * as assert from 'assert';
import { extractStrings, replaceInterpolations } from '../../src/detection/stringExtractor';
import { findPerlInterpolationSpans } from '../../src/detection/interpolations';

describe('String Extractor', () => {
  describe('TypeScript/JavaScript', () => {
    it('should extract template literals', () => {
      const code = 'const q = `SELECT * FROM users`;';
      const strings = extractStrings(code, 'typescript');
      assert.strictEqual(strings.length, 1);
      assert.strictEqual(strings[0].content, 'SELECT * FROM users');
      assert.strictEqual(strings[0].type, 'template');
    });

    it('should extract double-quoted strings', () => {
      const code = 'const q = "SELECT * FROM users";';
      const strings = extractStrings(code, 'typescript');
      assert.strictEqual(strings.length, 1);
      assert.strictEqual(strings[0].content, 'SELECT * FROM users');
    });

    it('should extract single-quoted strings', () => {
      const code = "const q = 'SELECT * FROM users';";
      const strings = extractStrings(code, 'typescript');
      assert.strictEqual(strings.length, 1);
      assert.strictEqual(strings[0].content, 'SELECT * FROM users');
    });

    it('should handle template literals with interpolations', () => {
      const code = 'const q = `SELECT * FROM users WHERE id = ${userId}`;';
      const strings = extractStrings(code, 'typescript');
      assert.strictEqual(strings.length, 1);
      assert.ok(strings[0].content.includes('${userId}'));
    });

    it('should skip single-line comments', () => {
      const code = '// const q = "not a string";\nconst q = "real string";';
      const strings = extractStrings(code, 'typescript');
      assert.strictEqual(strings.length, 1);
      assert.strictEqual(strings[0].content, 'real string');
    });

    it('should skip multi-line comments', () => {
      const code = '/* "not a string" */ const q = "real string";';
      const strings = extractStrings(code, 'typescript');
      assert.strictEqual(strings.length, 1);
      assert.strictEqual(strings[0].content, 'real string');
    });

    it('should handle escaped quotes', () => {
      const code = 'const q = "SELECT \\"name\\" FROM users";';
      const strings = extractStrings(code, 'typescript');
      assert.strictEqual(strings.length, 1);
    });

    it('should extract multiple strings', () => {
      const code = 'const a = "first"; const b = "second";';
      const strings = extractStrings(code, 'typescript');
      assert.strictEqual(strings.length, 2);
    });
  });

  describe('Python', () => {
    it('should extract double-quoted strings', () => {
      const code = 'q = "SELECT * FROM users"';
      const strings = extractStrings(code, 'python');
      assert.strictEqual(strings.length, 1);
      assert.strictEqual(strings[0].content, 'SELECT * FROM users');
    });

    it('should extract triple-quoted strings', () => {
      const code = 'q = """SELECT * FROM users"""';
      const strings = extractStrings(code, 'python');
      assert.strictEqual(strings.length, 1);
      assert.strictEqual(strings[0].content, 'SELECT * FROM users');
    });

    it('should extract f-strings', () => {
      const code = 'q = f"SELECT * FROM users WHERE id = {user_id}"';
      const strings = extractStrings(code, 'python');
      assert.strictEqual(strings.length, 1);
      assert.ok(strings[0].content.includes('{user_id}'));
    });

    it('should skip comments', () => {
      const code = '# "not a string"\nq = "real string"';
      const strings = extractStrings(code, 'python');
      assert.strictEqual(strings.length, 1);
      assert.strictEqual(strings[0].content, 'real string');
    });

    it('should handle multiline triple-quoted strings', () => {
      const code = 'q = """\n  SELECT *\n  FROM users\n"""';
      const strings = extractStrings(code, 'python');
      assert.strictEqual(strings.length, 1);
      assert.ok(strings[0].content.includes('SELECT'));
      assert.ok(strings[0].content.includes('FROM'));
    });
  });

  describe('Java', () => {
    it('should extract double-quoted strings', () => {
      const code = 'String q = "SELECT * FROM users";';
      const strings = extractStrings(code, 'java');
      assert.strictEqual(strings.length, 1);
      assert.strictEqual(strings[0].content, 'SELECT * FROM users');
    });

    it('should extract text blocks', () => {
      const code = 'String q = """\n    SELECT * FROM users\n    """;';
      const strings = extractStrings(code, 'java');
      assert.strictEqual(strings.length, 1);
      assert.ok(strings[0].content.includes('SELECT'));
      assert.strictEqual(strings[0].type, 'textblock');
    });

    it('should skip comments', () => {
      const code = '// "not a string"\nString q = "real string";';
      const strings = extractStrings(code, 'java');
      assert.strictEqual(strings.length, 1);
      assert.strictEqual(strings[0].content, 'real string');
    });

    it('should skip char literals', () => {
      const code = "char c = 'x'; String q = \"real string\";";
      const strings = extractStrings(code, 'java');
      assert.strictEqual(strings.length, 1);
      assert.strictEqual(strings[0].content, 'real string');
    });
  });

  describe('C#', () => {
    it('should extract regular strings', () => {
      const code = 'string q = "SELECT * FROM users";';
      const strings = extractStrings(code, 'csharp');
      assert.strictEqual(strings.length, 1);
      assert.strictEqual(strings[0].content, 'SELECT * FROM users');
    });

    it('should extract verbatim strings', () => {
      const code = 'string q = @"SELECT * FROM users WHERE name = ""test""";';
      const strings = extractStrings(code, 'csharp');
      assert.strictEqual(strings.length, 1);
      assert.strictEqual(strings[0].type, 'verbatim');
    });

    it('should extract interpolated strings', () => {
      const code = 'string q = $"SELECT * FROM users WHERE id = {userId}";';
      const strings = extractStrings(code, 'csharp');
      assert.strictEqual(strings.length, 1);
    });

    it('should extract interpolated verbatim strings ($@)', () => {
      const code = 'string q = $@"SELECT * FROM users WHERE id = {userId}";';
      const strings = extractStrings(code, 'csharp');
      assert.strictEqual(strings.length, 1);
      assert.strictEqual(strings[0].type, 'verbatim');
    });

    it('should extract interpolated verbatim strings (@$)', () => {
      const code = 'string q = @$"SELECT * FROM users WHERE id = {userId}";';
      const strings = extractStrings(code, 'csharp');
      assert.strictEqual(strings.length, 1);
      assert.strictEqual(strings[0].type, 'verbatim');
    });

    it('should skip comments', () => {
      const code = '// "not a string"\nstring q = "real string";';
      const strings = extractStrings(code, 'csharp');
      assert.strictEqual(strings.length, 1);
      assert.strictEqual(strings[0].content, 'real string');
    });
  });

  describe('Perl', () => {
    it('should extract single-line and multiline double-quoted strings without inverting quotes', () => {
      const code = 'my $q = "SELECT *\nFROM users\nWHERE id = $id";\nmy $next = "tail";';
      const strings = extractStrings(code, 'perl');
      assert.strictEqual(strings.length, 2);
      assert.strictEqual(strings[0].content, 'SELECT *\nFROM users\nWHERE id = $id');
      assert.strictEqual(strings[1].content, 'tail');
    });

    it('should extract q and qq strings including whitespace and nested delimiters in interpolations', () => {
      const code = [
        'my $a = q {SELECT * FROM users};',
        'my $b = qq{SELECT * FROM users WHERE k = $h{"}"}};',
        'my @ignored = qw(SELECT * FROM users);',
        'my $cmd = qx{echo "SELECT * FROM users"};',
        'my $re = qr/can\'t match/;',
      ].join('\n');
      const strings = extractStrings(code, 'perl');
      assert.strictEqual(strings.length, 2);
      assert.strictEqual(strings[0].content, 'SELECT * FROM users');
      assert.strictEqual(strings[1].content, 'SELECT * FROM users WHERE k = $h{"}"}');
    });

    it('should extract <<, <<~, quoted, and backslashed heredocs while skipping backtick heredocs', () => {
      const code = [
        'my $a = <<SQL;',
        'SELECT * FROM users',
        'SQL',
        'my $b = <<~SQL;',
        '    SELECT * FROM accounts',
        '    SQL',
        'my $c = <<\\SQL;',
        'SELECT * FROM $literal',
        'SQL',
        'my $sh = <<`CMD`;',
        'echo "SELECT * FROM shell"',
        'CMD',
      ].join('\n') + '\n';
      const strings = extractStrings(code, 'perl');
      assert.strictEqual(strings.length, 3);
      assert.strictEqual(strings[0].type, 'heredoc');
      assert.strictEqual(strings[0].closingIndent, '');
      assert.strictEqual(strings[0].interpolationWidth, 1);
      assert.strictEqual(strings[1].closingIndent, '    ');
      assert.strictEqual(strings[2].interpolationWidth, 0);
    });

    it('should not confuse method calls, fat-comma keys, bitshifts, comments, or POD with strings', () => {
      const code = [
        '=head1 NAME',
        '"ignored in pod"',
        '=cut',
        '# "ignored in comment"',
        'my $len = $#items; # not a comment until second #',
        'my $res = $dbh->q("SELECT 1 FROM dual");',
        'my $pkg = Pkg::qq("SELECT 2 FROM dual");',
        'my %map = (q => "SELECT 3 FROM dual");',
        'my $shift = 1 << SHIFT_MASK;',
        'my $out = `echo "can\'t"`;',
      ].join('\n');
      const strings = extractStrings(code, 'perl');
      assert.deepStrictEqual(strings.map(s => s.content), [
        'SELECT 1 FROM dual',
        'SELECT 2 FROM dual',
        'SELECT 3 FROM dual',
      ]);
    });

    it('skips regex literals and quote-named variables so quotes cannot invert scanning', () => {
      const code = [
        "my $clean = $value =~ s/'/''/g;",
        "if ($path =~ m/don't\\/care/) { }",
        "my $parts = split /'/, $line;",
        'local $" = \', \';',
        'my $post = $\';',
        'my $pre = $`;',
        'my $q = "SELECT id FROM users WHERE id = 1";',
      ].join('\n');
      const strings = extractStrings(code, 'perl');
      assert.ok(strings.some(s => s.content === 'SELECT id FROM users WHERE id = 1'));
      assert.ok(!strings.some(s => s.content.includes("don't") || s.content.includes('care')));
    });

    it('stops scanning at __END__ and __DATA__ so trailing prose is not parsed as Perl', () => {
      const end = 'my $q = "SELECT id FROM users";\n__END__\nmy $doc = "SELECT * FROM prose";\n';
      assert.deepStrictEqual(extractStrings(end, 'perl').map(s => s.content), ['SELECT id FROM users']);
      const data = 'my $q = "SELECT id FROM users";\n__DATA__\n"SELECT * FROM prose"\n';
      assert.deepStrictEqual(extractStrings(data, 'perl').map(s => s.content), ['SELECT id FROM users']);
    });

    it('does not treat autoquoted hash keys or assignments to s as quote-like operators', () => {
      const code = [
        'my $a = $row->{q};',
        'my $b = $row->{ qq };',
        'my $c = $h{s};',
        'my $s = 1;',
        'my $d = "SELECT id FROM users";',
      ].join('\n');
      assert.deepStrictEqual(extractStrings(code, 'perl').map(s => s.content), ['SELECT id FROM users']);
    });

    it('consumes trailing flags on bare regexes so /m and /s do not swallow following SQL', () => {
      const code = [
        'my $h = /header/m;',
        'my $b = /body/s;',
        'next if /don\'t/i;',
        'last unless /can\'t/;',
        'my $q = "SELECT id FROM users WHERE active = 1";',
      ].join('\n');
      assert.deepStrictEqual(
        extractStrings(code, 'perl').map(s => s.content),
        ['SELECT id FROM users WHERE active = 1'],
      );
    });

    it('supports whitespace before non-bracketing delimiters and -s filetest operators', () => {
      const code = [
        'if (-s $fh && -s \'config.ini\') { }',
        'my $clean = $val =~ s /\'/\'\'/g;',
        'my $q1 = q /SELECT 1 FROM dual/;',
        'my $q2 = qq |SELECT 2 FROM $table|;',
      ].join('\n');
      assert.deepStrictEqual(extractStrings(code, 'perl').map(s => s.content), [
        'config.ini',
        'SELECT 1 FROM dual',
        'SELECT 2 FROM $table',
      ]);
    });

    it('treats multiline division and keyword-named variables as division, not regexes', () => {
      const code = [
        'my $avg = $total',
        '  / $count;',
        'my $half = $split / 2 + $map / 2 + $or / 2 + $obj->split / 2;',
        'my $q = "SELECT id FROM users";',
        'my $other = $x / 2;',
      ].join('\n');
      assert.deepStrictEqual(extractStrings(code, 'perl').map(s => s.content), ['SELECT id FROM users']);
    });

    it('disables interpolation for single-quote regex delimiters while keeping qq\'...\' interpolating', () => {
      const code = [
        "if ($str =~ m'$x{') { }",
        "$str =~ s'$x{'y';",
        "my $q = qq'SELECT id FROM $table';",
      ].join('\n');
      const strings = extractStrings(code, 'perl');
      assert.strictEqual(strings.length, 1);
      assert.strictEqual(strings[0].content, 'SELECT id FROM $table');
      assert.strictEqual(strings[0].interpolationWidth, 1);
    });
  });
});

describe('Replace Interpolations', () => {
  it('should replace JS template interpolations', () => {
    const result = replaceInterpolations('SELECT * FROM users WHERE id = ${userId}', 'typescript');
    assert.ok(!result.includes('${'));
    assert.ok(result.includes('__P__'));
  });

  it('should replace Python f-string interpolations', () => {
    const result = replaceInterpolations('SELECT * FROM users WHERE id = {user_id}', 'python');
    assert.ok(!result.includes('{user_id}'));
    assert.ok(result.includes('__P__'));
  });

  it('should preserve escaped braces in Python', () => {
    const result = replaceInterpolations('SELECT {{col}} FROM users WHERE id = {user_id}', 'python');
    assert.ok(result.includes('{col}'));
    assert.ok(result.includes('__P__'));
  });

  it('should replace C# interpolations', () => {
    const result = replaceInterpolations('SELECT * FROM users WHERE id = {userId}', 'csharp');
    assert.ok(!result.includes('{userId}'));
    assert.ok(result.includes('@__p__'));
  });

  it('should not modify Java strings', () => {
    const input = 'SELECT * FROM users WHERE id = ?';
    const result = replaceInterpolations(input, 'java');
    assert.strictEqual(result, input);
  });

  it('should replace Perl interpolations without consuming SQL -> or ->> operators', () => {
    const sql = "SELECT $col->'a', $col->>'b' FROM ${schema}.users WHERE id = $u->{id} AND n <= $#arr";
    const result = replaceInterpolations(sql, 'perl');
    assert.strictEqual(
      result,
      "SELECT __P__->'a', __P__->>'b' FROM __P__.users WHERE id = __P__ AND n <= __P__"
    );
  });

  it('should compute exact Perl interpolation spans for keyword-named variables', () => {
    const sql = 'SELECT $select, @values FROM $$table WHERE id = $user->{id}';
    const spans = findPerlInterpolationSpans(sql).map(s => sql.slice(s.start, s.end));
    assert.deepStrictEqual(spans, ['$select', '@values', '$$table', '$user->{id}']);
  });

  it('should leave bare trailing dollars and quote escapes outside interpolations', () => {
    assert.deepStrictEqual(findPerlInterpolationSpans('SELECT * FROM t WHERE c > 5$'), []);
    assert.deepStrictEqual(findPerlInterpolationSpans("SELECT '$'' FROM t"), []);
    assert.deepStrictEqual(findPerlInterpolationSpans('SELECT $\\d FROM t'), []);
  });

  it('should consume postfix dereferences so slices and last-index forms are protected', () => {
    const sql = 'SELECT * FROM t WHERE id IN ($ids->@*) AND n = $ids->$#* AND k = $ids->@[0,1]';
    const spans = findPerlInterpolationSpans(sql).map(s => sql.slice(s.start, s.end));
    assert.deepStrictEqual(spans, ['$ids->@*', '$ids->$#*', '$ids->@[0,1]']);
  });
});

describe('Host string boundary regressions', () => {
  it('extracts single-line C# raw strings with longer quote delimiters', () => {
    const strings = extractStrings('var q = """"SELECT \'"""\' FROM users"""";', 'csharp');
    assert.strictEqual(strings.length, 1);
    assert.strictEqual(strings[0].content, 'SELECT \'"""\' FROM users');
  });

  it('handles quotes inside C# verbatim interpolation expressions', () => {
    const strings = extractStrings('var q = $@"SELECT id FROM users WHERE id = {values["key"]}";', 'csharp');
    assert.strictEqual(strings.length, 1);
    assert.ok(strings[0].content.endsWith('{values["key"]}'));
  });

  it('handles quotes inside Python f-string expressions', () => {
    const strings = extractStrings('q = f"SELECT id FROM users WHERE id = {values["key"]}"', 'python');
    assert.strictEqual(strings.length, 1);
    assert.ok(strings[0].content.endsWith('{values["key"]}'));
  });

  it('handles nested templates without losing the outer SQL boundary', () => {
    const source = 'const q = `SELECT id FROM users WHERE id = ${fn(`a${fn(`b${id}`)}`)} AND active = 1`;';
    const strings = extractStrings(source, 'typescript');
    assert.strictEqual(strings.length, 1);
    assert.ok(strings[0].content.endsWith('AND active = 1'));
  });

  it('does not mistake Python floor division for a host comment', () => {
    const strings = extractStrings('q = f"SELECT id FROM users LIMIT {count // 2}"', 'python');
    assert.strictEqual(strings.length, 1);
    assert.ok(strings[0].content.endsWith('{count // 2}'));
  });
});
