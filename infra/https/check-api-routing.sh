#!/usr/bin/env bash
# Read-only checks; no credentials, account creation or webhook events.
set -euo pipefail
base="${1:-}"
if [[ -z "$base" ]]; then
    base="https://${DVA_PUBLIC_IP:?Set DVA_PUBLIC_IP or pass a base URL}"
fi
base="${base%/}"
check() {
    local path="$1" expected="$2" actual
    actual=$(curl --silent --show-error --max-time 15 --output /dev/null \
        --write-out '%{http_code}' -- "$base$path")
    [[ "$actual" == "$expected" ]] || {
        echo "FAIL: $path expected $expected, got $actual" >&2
        return 1
    }
    echo "PASS: $path $actual"
}
check /https-health 200
check /api/docs 200
check /api/docs-json 200
check /api/auth/me 401
check /api/admins 401
check /api/companies 401
check /api/health/ready 404
check /api/health/ready/ 404
check /api/webhooks/pbx/call-ended 405
check /jenkins 301
