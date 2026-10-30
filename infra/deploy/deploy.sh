#!/usr/bin/env bash
set -euo pipefail
umask 077

# Layout: <root>/releases/<version>/deploy.sh and <root>/shared/.env
release_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
version="$(basename -- "$release_dir")"
[[ "$version" =~ ^[a-z0-9][a-z0-9.-]{0,79}$ ]] || { echo 'Invalid release version.' >&2; exit 1; }
releases_dir="$(dirname -- "$release_dir")"
[[ "$(basename -- "$releases_dir")" == releases ]] || { echo 'Place the release under <root>/releases/<version>.' >&2; exit 1; }
deploy_root="$(dirname -- "$releases_dir")"
secrets_file="$deploy_root/shared/.env"
current_file="$deploy_root/current-release"
previous_file="$deploy_root/previous-release"
[[ -f "$secrets_file" ]] || { echo "Missing server-only settings: $secrets_file" >&2; exit 1; }
chmod 600 "$secrets_file"

if [[ "$EUID" -eq 0 ]]; then
    docker_cmd=(docker)
else
    docker_cmd=(sudo -n docker)
fi
"${docker_cmd[@]}" info >/dev/null

# Prevent overlapping manual/Jenkins deploys to the same Compose project.
exec 9>"$deploy_root/deploy.lock"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }

compose() {
    local directory="$1"
    shift
    "${docker_cmd[@]}" compose --project-name dva-prod \
        --env-file "$secrets_file" --env-file "$directory/release.env" \
        --file "$directory/compose.prod.yaml" "$@"
}

apply_release() {
    local directory="$1"
    compose "$directory" config --quiet || return 1
    compose "$directory" up -d --no-build --pull never --wait --wait-timeout 180 || return 1
    curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8082/nginx-health || return 1
    curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8082/api/health || return 1
    compose "$directory" exec -T backend node -e \
        "fetch('http://127.0.0.1:3000/health/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" </dev/null || return 1
}

database_container() {
    local db_container
    db_container="$(compose "$release_dir" ps -q db)" || return 1
    if [[ -z "$db_container" ]]; then
        # On a fresh server start only PostgreSQL; no new backend may run before SQL succeeds.
        compose "$release_dir" up -d --no-deps --no-build --pull never --wait --wait-timeout 180 db >&2 || return 1
        db_container="$(compose "$release_dir" ps -q db)" || return 1
    fi
    [[ "$db_container" =~ ^[a-zA-Z0-9_.-]+$ ]] || return 1
    printf '%s' "$db_container"
}

migrate_release() {
    local directory="$1" db_container
    local migration_args
    db_container="$(database_container)" || return 1
    migration_args=(--no-backup "$db_container")
    if [[ "$backup_required" == true ]]; then
        migration_args=("$db_container" "$deploy_root/shared/db-backups")
    fi
    if [[ "$EUID" -eq 0 ]]; then
        sh "$directory/infra/database/migrate.sh" "${migration_args[@]}" </dev/null || return 1
    else
        sudo -n sh "$directory/infra/database/migrate.sh" "${migration_args[@]}" </dev/null || return 1
    fi
    "${docker_cmd[@]}" exec -i "$db_container" sh -c \
        'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
        < "$directory/infra/database/verify.sql" || return 1
}

read_creation_schema() {
    local db_container state
    db_container="$(database_container)" || return 1
    state="$("${docker_cmd[@]}" exec "$db_container" sh -c \
        'exec psql -X -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' sh \
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='creation_request_id')" </dev/null)" || return 1
    [[ "$state" == t || "$state" == f ]] || return 1
    printf '%s' "$state"
}

read_membership_schema() {
    local db_container state
    db_container="$(database_container)" || return 1
    state="$("${docker_cmd[@]}" exec "$db_container" sh -c \
        'exec psql -X -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' sh \
        "SELECT to_regclass('api_idempotency.membership_writes') IS NOT NULL" </dev/null)" || return 1
    [[ "$state" == t || "$state" == f ]] || return 1
    printf '%s' "$state"
}

check_membership_compatibility() {
    local directory="$1" state
    # 010 이후 앱은 요청 기록을 사용하지 않으며, 이전 구성원 앱만 테이블을 요구한다.
    [[ -f "$directory/backend/migrations/009-membership-write-requests.sql" &&
       ! -f "$directory/backend/migrations/$membership_migration" ]] || return 0
    state="$(read_membership_schema)" || return 1
    [[ "$state" == t ]] || {
        echo 'Deployment/restore blocked: the target app requires removed membership receipts.' >&2
        return 1
    }
}

read_billing_schema() {
    local db_container state
    db_container="$(database_container)" || return 1
    state="$("${docker_cmd[@]}" exec "$db_container" sh -c \
        'exec psql -X -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' sh \
        "SELECT to_regclass('public.departments') IS NOT NULL" </dev/null)" || return 1
    [[ "$state" == t || "$state" == f ]] || return 1
    printf '%s' "$state"
}

check_billing_compatibility() {
    local directory="$1" state
    [[ -f "$directory/backend/migrations/$billing_migration" ]] && return 0
    state="$(read_billing_schema)" || return 1
    [[ "$state" == f ]] || {
        echo 'Deployment/restore blocked: the target app does not support departments and paid order states. Repair forward or restore the backup during maintenance.' >&2
        return 1
    }
}

read_company_history_schema() {
    local db_container state
    db_container="$(database_container)" || return 1
    state="$("${docker_cmd[@]}" exec "$db_container" sh -c \
        'exec psql -X -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' sh \
        "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='billing_organization_name')" </dev/null)" || return 1
    [[ "$state" == t || "$state" == f ]] || return 1
    printf '%s' "$state"
}

check_company_history_compatibility() {
    local directory="$1" state
    [[ -f "$directory/backend/migrations/$company_history_migration" ]] && return 0
    state="$(read_company_history_schema)" || return 1
    [[ "$state" == f ]] || {
        echo 'Deployment/restore blocked: the target app cannot preserve deleted company history or department PIN assignments. Repair forward or restore the backup during maintenance.' >&2
        return 1
    }
}

restore_previous() {
    local state
    if [[ -z "$old_version" || "$old_version" == "$version" ]]; then
        echo 'No older running release to restore. Inspect containers and logs.' >&2
        return 1
    fi
    state="$(read_creation_schema)" || { echo 'Cannot verify DB compatibility. Automatic restore blocked.' >&2; return 1; }
    # Migration 008 removes tables used by earlier application images.
    if [[ "$state" == t && ! -f "$releases_dir/$old_version/backend/migrations/$creation_migration" ]]; then
        echo 'Automatic restore blocked: the previous app requires removed creation tables. Repair forward or restore the backup during maintenance.' >&2
        return 1
    fi
    check_membership_compatibility "$releases_dir/$old_version" || return 1
    check_billing_compatibility "$releases_dir/$old_version" || return 1
    check_company_history_compatibility "$releases_dir/$old_version" || return 1
    echo "Restoring previous running release: $old_version" >&2
    if apply_release "$releases_dir/$old_version"; then
        echo 'Previous release restored. Deployment still reports failure.' >&2
    else
        echo 'Automatic restore failed. Inspect docker compose status and logs.' >&2
        return 1
    fi
}

read_version() {
    local file="$1" value
    [[ -f "$file" ]] || return 1
    value="$(cat -- "$file")"
    [[ "$value" =~ ^[a-z0-9][a-z0-9.-]{0,79}$ ]] || return 1
    [[ -f "$releases_dir/$value/compose.prod.yaml" && -f "$releases_dir/$value/release.env" ]] || return 1
    printf '%s' "$value"
}

old_version="$(read_version "$current_file" || true)"
creation_migration=008-simplify-creation-requests.sql
membership_migration=010-remove-membership-write-requests.sql
billing_migration=019-organization-monthly-billing.sql
company_history_migration=021-company-deletion-history.sql
backup_required=false
case "${1:-}" in
    '') ;;
    --rollback)
        version="$(read_version "$previous_file")" || { echo 'No previous release available.' >&2; exit 1; }
        release_dir="$releases_dir/$version"
        ;;
    *) echo 'Usage: bash deploy.sh [--rollback]' >&2; exit 1 ;;
esac

# A release must be fully transferred before this command is invoked.
if [[ "${1:-}" != --rollback ]]; then
    (cd -- "$release_dir" && sha256sum --check --status images.tar.sha256)
    (cd -- "$release_dir" && sha256sum --check --status release-files.sha256)
    compose "$release_dir" config --quiet
    "${docker_cmd[@]}" image load --input "$release_dir/images.tar"
fi

schema_state="$(read_creation_schema)" || { echo 'Cannot verify DB compatibility. Deployment stopped.' >&2; exit 1; }
if [[ "$schema_state" == t && ! -f "$release_dir/backend/migrations/$creation_migration" ]]; then
    echo 'Deployment/rollback blocked: the target app requires removed creation tables.' >&2
    exit 1
fi
check_membership_compatibility "$release_dir" || exit 1
check_billing_compatibility "$release_dir" || exit 1
check_company_history_compatibility "$release_dir" || exit 1
company_history_state="$(read_company_history_schema)" || { echo 'Cannot verify company history schema. Deployment stopped.' >&2; exit 1; }
billing_state="$(read_billing_schema)" || { echo 'Cannot verify billing schema. Deployment stopped.' >&2; exit 1; }
membership_state=f
if [[ -f "$release_dir/backend/migrations/$membership_migration" ]]; then
    membership_state="$(read_membership_schema)" || { echo 'Cannot verify membership schema. Deployment stopped.' >&2; exit 1; }
fi

if [[ "${1:-}" != --rollback ]]; then
    if [[ "$schema_state" == f && -f "$release_dir/backend/migrations/$creation_migration" ]] ||
       [[ "$membership_state" == t && -f "$release_dir/backend/migrations/$membership_migration" ]] ||
       [[ "$billing_state" == f && -f "$release_dir/backend/migrations/$billing_migration" ]] ||
       [[ "$company_history_state" == f && -f "$release_dir/backend/migrations/$company_history_migration" ]]; then
        # Quiesce old writers before the backup and breaking schema conversion.
        compose "$release_dir" stop backend
        backup_required=true
    fi
    if ! migrate_release "$release_dir"; then
        echo 'Database migration/verification failed. New application deployment stopped.' >&2
        if [[ "$backup_required" == true ]]; then restore_previous || true; fi
        exit 1
    fi
fi

if apply_release "$release_dir"; then
    if [[ -n "$old_version" && "$old_version" != "$version" ]]; then
        printf '%s\n' "$old_version" > "$previous_file.tmp"
        mv -- "$previous_file.tmp" "$previous_file"
    fi
    printf '%s\n' "$version" > "$current_file.tmp"
    mv -- "$current_file.tmp" "$current_file"
    echo "Deployment verified: $version"
else
    echo "Deployment failed: $version" >&2
    compose "$release_dir" stop backend || echo 'Could not stop the failed backend. Inspect containers.' >&2
    restore_previous || true
    exit 1
fi
