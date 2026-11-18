# Perl test fixture for SQL detection
use strict;
use warnings;

=head1 DESCRIPTION

SELECT * FROM ignored_pod_table WHERE id = 1

=cut

my $simple_query = "SELECT id, name FROM users WHERE active = 1";

my $single_quoted = 'INSERT INTO users (name, email) VALUES (?, ?)';

my $qq_query = qq{
    SELECT u.id, u.name
    FROM $schema.users u
    WHERE u.id = $params->{user_id}
};

my $heredoc_query = <<~SQL;
    SELECT u.id, u.name, u.email
    FROM users u
    INNER JOIN orders o ON u.id = o.user_id
    WHERE o.status = 'completed'
    ORDER BY u.name ASC
    SQL

# Non-SQL constructs (should NOT be detected)
my @words = qw(SELECT FROM users WHERE);
my $mask = 1 << 4;
my $greeting = "Hello, World!";
my $url = "https://api.example.com/users";
