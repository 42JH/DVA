#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$EUID" -eq 0 ]] || { echo 'Run with sudo' >&2; exit 1; }
source_file="${1:?New HTTPS config required}"
expected_hash="${2:?Expected current config SHA-256 required}"
[[ "$expected_hash" =~ ^[a-f0-9]{64}$ ]] || exit 1
current=/etc/nginx/sites-available/dva-ip
[[ -f "$current" && -f "$source_file" ]] || exit 1
[[ "$(sha256sum "$current" | cut -d ' ' -f 1)" == "$expected_hash" ]] || {
 echo 'Nginx config changed since inspection; refusing to overwrite.' >&2; exit 1;
}
backup_dir=/home/ubuntu/dva-jenkins/backups
install -d -m 700 "$backup_dir"
backup="$backup_dir/nginx-dva-ip-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$current" "$backup"
install -m 644 "$source_file" "$current"
if ! nginx -t || ! systemctl reload nginx; then
 cp -p "$backup" "$current"
 nginx -t && systemctl reload nginx
 echo 'Jenkins proxy update failed; restored previous Nginx config.' >&2
 exit 1
fi
echo "Jenkins HTTPS route installed; previous config: $backup"
