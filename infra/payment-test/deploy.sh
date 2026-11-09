#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$EUID" -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
settings="$(realpath -- "${1:?Usage: sudo bash deploy.sh /srv/dva-payment-test/settings}")"
[[ "$settings" == /srv/dva-payment-test/settings && -f "$settings" && ! -L "$settings" ]] || exit 1
[[ ! -L /srv/dva-payment-test && ! -L /srv/dva-payment-test/data ]] || exit 1
chmod 600 "$settings"
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Deployment already running.' >&2; exit 1; }
# Validate without evaluating settings as shell code and without printing secret values.
docker run --rm --env-file "$settings" -e NODE_ENV=production \
  --mount "type=bind,src=$root/../../backend/payment-test,dst=/app,readonly" \
  --entrypoint node node:24-bookworm-slim \
  --input-type=module -e 'import { configuration } from "/app/config.mjs"; try { configuration(); console.log("Payment test settings valid"); } catch { console.error("Invalid payment test settings; see README"); process.exit(1); }'
install -d -m 0700 -o 1000 -g 1000 /srv/dva-payment-test/data
export PAYMENT_TEST_SETTINGS="$settings"
compose=(docker compose --file "$root/compose.yaml" --project-name dva-payment-test)
"${compose[@]}" config --quiet
"${compose[@]}" up -d --build
curl --fail --silent --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:3002/health
echo
echo 'Payment test service started; apply the HTTPS location and explicitly run request.mjs to send one message.'
