#!/usr/bin/env bash
# Syntax/certificate validation only. Does not edit or reload the active Nginx configuration.
set -euo pipefail
source_file="${1:?Candidate HTTPS config required}"
[[ "$EUID" -eq 0 && -f "$source_file" ]] || exit 1
source_file="$(readlink -f "$source_file")"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT
cat > "$test_root/nginx.conf" <<EOF
pid $test_root/nginx.pid;
error_log stderr;
events { worker_connections 64; }
http {
    include /etc/nginx/mime.types;
    access_log off;
    include $source_file;
}
EOF
nginx -t -c "$test_root/nginx.conf"
