#!/usr/bin/env bash
# 대상 서버에서 실행: AI 서버 릴리스를 띄우고, 실패하면 직전 릴리스로 되돌린다(백엔드 infra/deploy/deploy.sh와 같은 구조).
# 배치: <root>/releases/<version>/{deploy.sh, release.env, compose.yaml, compose.deploy.yaml, config/, prompts/}, 비밀값 <root>/shared/.env
# 이미지는 upload.sh가 미리 docker load 해 둔다.
set -euo pipefail
umask 077

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

# 수동·Jenkins 배포가 겹치지 않게
exec 9>"$deploy_root/deploy.lock"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }

compose() {
    local directory="$1"
    shift
    "${docker_cmd[@]}" compose --project-name dva-ai \
        --env-file "$secrets_file" --env-file "$directory/release.env" \
        --file "$directory/compose.yaml" --file "$directory/compose.deploy.yaml" "$@"
}

apply_release() {
    local directory="$1"
    compose "$directory" config --quiet || return 1
    compose "$directory" up -d --no-build --pull missing --remove-orphans --wait --wait-timeout 120 || return 1
}

read_version() {
    local file="$1" value
    [[ -f "$file" ]] || return 1
    value="$(cat -- "$file")"
    [[ "$value" =~ ^[a-z0-9][a-z0-9.-]{0,79}$ && -f "$releases_dir/$value/release.env" ]] || return 1
    printf '%s' "$value"
}

# 백엔드 스택(dva-prod)이 외부 네트워크로 쓰는 AI 연결 네트워크. 없으면 만든다
"${docker_cmd[@]}" network inspect dva-prod_ai_net >/dev/null 2>&1 || "${docker_cmd[@]}" network create dva-prod_ai_net >/dev/null

old_version="$(read_version "$current_file" || true)"
if apply_release "$release_dir"; then
    if [[ -n "$old_version" && "$old_version" != "$version" ]]; then
        printf '%s\n' "$old_version" > "$previous_file.tmp"
        mv -- "$previous_file.tmp" "$previous_file"
    fi
    printf '%s\n' "$version" > "$current_file.tmp"
    mv -- "$current_file.tmp" "$current_file"
    # 백엔드 스택이 띄웠던 예전 AI가 같은 별칭(ai)을 쓰므로 새 AI가 뜬 뒤 멈춘다. 지우지 않으니 docker start로 되살릴 수 있다
    if [[ -n "$("${docker_cmd[@]}" ps -q --filter name=^dva-prod-ai-1$)" ]]; then
        "${docker_cmd[@]}" stop dva-prod-ai-1 >/dev/null
        echo 'Stopped legacy container dva-prod-ai-1 (not removed).'
    fi
    # 지금·직전 릴리스 이미지만 남긴다(다른 관리자의 서버이므로 docker image prune은 쓰지 않는다)
    keep="dva-ai-server:$version"
    [[ -n "$old_version" ]] && keep="$keep|dva-ai-server:$old_version"
    "${docker_cmd[@]}" image ls dva-ai-server --format '{{.Repository}}:{{.Tag}}' | grep -Evx "$keep" \
        | xargs -r "${docker_cmd[@]}" image rm >/dev/null || true
    echo "Deployment verified: $version"
else
    echo "Deployment failed: $version" >&2
    compose "$release_dir" logs --tail 100 ai >&2 || true
    if [[ -n "$old_version" && "$old_version" != "$version" ]]; then
        echo "Restoring previous running release: $old_version" >&2
        if apply_release "$releases_dir/$old_version"; then
            echo 'Previous release restored. Deployment still reports failure.' >&2
        else
            echo 'Automatic restore failed. Inspect docker compose status and logs.' >&2
        fi
    fi
    exit 1
fi
