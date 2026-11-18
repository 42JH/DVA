#!/bin/bash
# 호스트 이름은 공개 DNS이며 키/계정 정보는 인수로 받지 않는다.
set -euo pipefail
host="${1:?HTTPS 호스트가 필요합니다}"
if ! [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\.sslip\.io$ ]]; then
  echo '허용한 임시 DNS 형식이 아닙니다.' >&2
  exit 1
fi
install -d -m 0755 /opt/dvr-reranker/caddy-data /opt/dvr-reranker/caddy-config
cat > /etc/dvr-reranker/Caddyfile <<EOF
${host} {
    request_body {
        max_size 256KB
    }
    reverse_proxy 127.0.0.1:8001
}
EOF
chmod 0644 /etc/dvr-reranker/Caddyfile
install -m 0644 /opt/dvr-reranker/source/deploy/gcp/dvr-reranker-proxy.service /etc/systemd/system/dvr-reranker-proxy.service
systemctl daemon-reload
systemctl enable dvr-reranker-proxy.service
systemctl restart dvr-reranker-proxy.service
