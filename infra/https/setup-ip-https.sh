#!/usr/bin/env bash
# Installation runs as root on the Lightsail host. Rendering writes only to stdout.
set -euo pipefail
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
mode=${1:-}
case "$mode" in
    bootstrap|staging|issue|render-http|render-https) ;;
    *) echo 'Usage: setup-ip-https.sh bootstrap|staging|issue|render-http|render-https' >&2; exit 1 ;;
esac
ip=${DVA_PUBLIC_IP:?Set DVA_PUBLIC_IP to the public IPv4 address}
octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
[[ "$ip" =~ ^$octet(\.$octet){3}$ ]] || { echo 'Invalid DVA_PUBLIC_IP.' >&2; exit 1; }

render_config() {
    local webhook_host="${ip//./-}.sslip.io"
    sed -e "s/server_name 192\.0\.2\.10;/server_name $ip;/" \
        -e "s/server_name webhook\.example\.test;/server_name $webhook_host;/" \
        "$source_dir/$1.conf"
}

case "$mode" in
    render-http|render-https) render_config "${mode#render-}"; exit ;;
esac
[[ "$EUID" -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
config=/etc/nginx/sites-available/dva-ip
certbot=/opt/dva-certbot/bin/certbot
assets=/opt/dva-ip-https

apply_config() (
    local template="$1" work_dir
    work_dir="$(mktemp -d)"
    trap 'rm -f -- "$work_dir/previous" "$work_dir/candidate"; rmdir -- "$work_dir"' EXIT
    render_config "$template" > "$work_dir/candidate"
    if [[ -f "$config" ]]; then cp -- "$config" "$work_dir/previous"; fi
    install -m 644 "$work_dir/candidate" "$config"
    ln -sfn "$config" /etc/nginx/sites-enabled/dva-ip
    if ! /usr/sbin/nginx -t; then
        if [[ -s "$work_dir/previous" ]]; then cp -- "$work_dir/previous" "$config"; fi
        echo 'Nginx validation failed; existing running configuration was not reloaded.' >&2
        exit 1
    fi
    systemctl enable --now nginx
    systemctl reload nginx
)

case "$mode" in
    bootstrap)
        apt-get update
        DEBIAN_FRONTEND=noninteractive apt-get install -y nginx python3-venv
        if [[ ! -x "$certbot" ]]; then
            python3 -m venv /opt/dva-certbot
            /opt/dva-certbot/bin/pip install 'certbot>=5.4'
        fi
        "$certbot" --version
        install -d -m 755 /var/www/dva-acme "$assets"
        install -m 755 "$source_dir/reload-nginx.sh" "$assets/reload-nginx.sh"
        # Only disable the distro-owned default symlink. Leave custom sites alone.
        if [[ -L /etc/nginx/sites-enabled/default ]] && [[ "$(readlink -f /etc/nginx/sites-enabled/default)" == /etc/nginx/sites-available/default ]]; then
            mv -- /etc/nginx/sites-enabled/default /etc/nginx/default-site.disabled
        fi
        if [[ -f /etc/letsencrypt/live/dva-ip/fullchain.pem ]]; then
            apply_config https
        else
            apply_config http
        fi
        echo 'HTTP ACME challenge listener ready. Verify public TCP 80 before issuing.'
        ;;
    staging|issue)
        [[ -x "$certbot" ]] || { echo 'Run bootstrap first.' >&2; exit 1; }
        account_args=(--register-unsafely-without-email)
        if [[ -n "${ACME_EMAIL:-}" ]]; then account_args=(--email "$ACME_EMAIL"); fi
        args=(certonly --non-interactive --agree-tos "${account_args[@]}"
            --preferred-profile shortlived --webroot --webroot-path /var/www/dva-acme
            --ip-address "$ip" --cert-name dva-ip)
        if [[ "$mode" == staging ]]; then
            "$certbot" "${args[@]}" --staging --config-dir /etc/letsencrypt-staging \
                --work-dir /var/lib/letsencrypt-staging --logs-dir /var/log/letsencrypt-staging
            echo 'Staging validation passed. This certificate is not installed for clients.'
        else
            restore_renewal_timer() {
                if [[ -f /etc/systemd/system/dva-certbot-renew.timer && -f /etc/letsencrypt/live/dva-ip/fullchain.pem ]]; then
                    systemctl enable --now dva-certbot-renew.timer >/dev/null 2>&1 || true
                fi
            }
            # Keep a working certificate's renewal scheduled even when a later validation fails.
            trap restore_renewal_timer EXIT
            # An overdue OnBootSec timer can fire as soon as it is enabled. Keep
            # scheduled renewal separate from the initial issuance/dry-run lock.
            systemctl stop dva-certbot-renew.timer 2>/dev/null || true
            if systemctl is-active --quiet dva-certbot-renew.service; then
                echo 'Scheduled renewal is running; retry issuance after it completes.' >&2
                exit 1
            fi
            "$certbot" "${args[@]}" --deploy-hook "$assets/reload-nginx.sh"
            apply_config https
            install -m 644 "$source_dir/dva-certbot-renew.service" /etc/systemd/system/dva-certbot-renew.service
            install -m 644 "$source_dir/dva-certbot-renew.timer" /etc/systemd/system/dva-certbot-renew.timer
            systemctl daemon-reload
            # Verify trust and IP matching without -k/--insecure.
            curl --fail --silent --show-error --max-time 10 --resolve "$ip:443:127.0.0.1" "https://$ip/https-health"
            "$certbot" renew --dry-run --run-deploy-hooks --no-random-sleep-on-renew
            systemctl start dva-certbot-renew.service
            systemctl enable --now dva-certbot-renew.timer
            openssl x509 -in /etc/letsencrypt/live/dva-ip/fullchain.pem -noout -dates -ext subjectAltName
            echo "HTTPS and renewal verified: https://$ip"
        fi
        ;;
esac
