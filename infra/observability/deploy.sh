#!/usr/bin/env bash
set -euo pipefail
umask 077
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
[[ "$EUID" -eq 0 ]] || { echo 'Run with sudo; creates only observability storage.' >&2; exit 1; }
settings="$(realpath -- "${1:?Usage: sudo ./deploy.sh /absolute/server/settings}")"
[[ -f "$settings" ]] || exit 1
chmod 600 "$settings"
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Observability deployment is already running.' >&2; exit 1; }
# 설정을 source/eval 하지 않고 Compose와 검증된 Node 렌더러에만 전달한다.
docker run --rm --env-file "$settings" --user 0:0 \
  --mount "type=bind,src=$root,dst=/work" --entrypoint node node:24-bookworm-slim \
  /work/render.mjs /work/.runtime --prepare
runtime="$root/.runtime"
# 외부 경로는 renderer가 검증한 절대 경로만 사용한다.
data_dir="$(cat "$runtime/data-dir")"
runtime_dir="$(cat "$runtime/runtime-dir")"
[[ "$data_dir" == /srv/dva-observability/data && "$runtime_dir" == /srv/dva-observability/runtime ]] || { echo 'Use the dedicated /srv/dva-observability paths.' >&2; exit 1; }
[[ ! -L /srv/dva-observability && ! -L "$data_dir" && ! -L "$runtime_dir" ]] || { echo 'Storage paths must not be symlinks.' >&2; exit 1; }
available_kb="$(df -Pk /srv | awk 'NR==2 { print $4 }')"
[[ "$available_kb" -ge 26214400 ]] || { echo 'Keep at least 25 GiB free before enabling log storage.' >&2; exit 1; }
install -d -m 0750 "$data_dir" "$runtime_dir"
install -d -m 0750 -o 10001 -g 10001 "$data_dir/loki"
install -d -m 0750 -o 65534 -g 65534 "$data_dir/prometheus" "$data_dir/alloy"
install -d -m 0750 -o 472 -g 472 "$data_dir/grafana" "$runtime_dir/alerting"
install -m 0640 -o 472 -g 472 "$runtime/alerting/resources.json" "$runtime_dir/alerting/resources.json"
install -m 0640 -o 472 -g 472 "$runtime/admin-password" "$runtime_dir/admin-password"
chmod 0700 "$runtime"
compose=(docker compose --project-name dva-observability --env-file "$settings" --file "$root/compose.yaml")
"${compose[@]}" config --quiet
"${compose[@]}" up -d --remove-orphans
# Bind-mounted file contents alone do not recreate containers; reload collection/query/alert rules.
"${compose[@]}" restart loki alloy grafana
echo 'Observability containers started. Verify health, sources and notification settings using README.md.'
