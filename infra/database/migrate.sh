#!/bin/sh
# Run on the Docker host. No application restart or environment-file output.
set -eu
umask 077
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
CONTAINER=${1:-dva-prod-db-1}
BACKUP_DIR=${2:-"$HOME/dva-deploy/shared/db-backups"}
case "$CONTAINER" in *[!a-zA-Z0-9_.-]*|'') echo 'Invalid container name' >&2; exit 1;; esac
command -v docker >/dev/null
command -v sha256sum >/dev/null
mkdir -p "$BACKUP_DIR"
BACKUP=$(mktemp "$BACKUP_DIR/pre-monolith-$(date -u +%Y%m%dT%H%M%SZ).dump-XXXXXX")
docker exec "$CONTAINER" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$BACKUP"
test -s "$BACKUP"
docker exec -i "$CONTAINER" pg_restore --list < "$BACKUP" > /dev/null
sha256sum "$BACKUP" > "$BACKUP.sha256"
echo "Backup: $BACKUP"

SQL=$(mktemp)
trap 'rm -f "$SQL"' EXIT HUP INT TERM
cat > "$SQL" <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(20261023, 1);
CREATE SCHEMA IF NOT EXISTS db_migrations;
CREATE TABLE IF NOT EXISTS db_migrations.applied_versions (
 version text PRIMARY KEY,
 sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
SQL
for FILE in "$ROOT"/backend/migrations/[0-9][0-9][0-9]-*.sql; do
 test -f "$FILE"
 VERSION=$(basename "$FILE")
 case "$VERSION" in *[!a-zA-Z0-9_.-]*) echo 'Invalid migration filename' >&2; exit 1;; esac
 CHECKSUM=$(sha256sum "$FILE" | cut -d ' ' -f 1)
 cat >> "$SQL" <<SQL
SELECT EXISTS(SELECT 1 FROM db_migrations.applied_versions WHERE version='$VERSION') AS already_applied \gset
\if :already_applied
 SELECT sha256='$CHECKSUM' AS checksum_matches FROM db_migrations.applied_versions WHERE version='$VERSION' \gset
 \if :checksum_matches
  \echo Already applied: $VERSION
 \else
  \echo ERROR: Previously applied migration checksum changed: $VERSION
  SELECT 1/0;
 \endif
\else
 \echo Applying: $VERSION
SQL
 cat "$FILE" >> "$SQL"
 printf '\n' >> "$SQL"
 cat >> "$SQL" <<SQL
INSERT INTO db_migrations.applied_versions(version,sha256) VALUES('$VERSION','$CHECKSUM');
\endif
SQL
done
printf '\nCOMMIT;\n' >> "$SQL"
docker exec -i "$CONTAINER" sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$SQL"
echo 'Migration committed.'
