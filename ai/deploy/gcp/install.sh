#!/bin/bash
# /opt/dvr-reranker/source에 검토한 배포 묶음을 푼 뒤 root로 실행한다.
set -euo pipefail
cd /opt/dvr-reranker/source
test -f /opt/dvr-reranker/bootstrap.ready
test -f /etc/dvr-reranker/runtime.conf
docker build -f gpu/Dockerfile -t dvr-reranker:local .
# 영구 캐시에 고정 버전만 받는다. 컨테이너 실행 때 인터넷에서 새 버전을 받지 않는다.
docker run --rm --user 10001:10001 --env HF_HUB_OFFLINE=0 \
  --volume /opt/dvr-reranker/models:/models \
  --entrypoint python dvr-reranker:local -c \
  "from huggingface_hub import snapshot_download; snapshot_download('Qwen/Qwen3-Reranker-0.6B',revision='e61197ed45024b0ed8a2d74b80b4d909f1255473',cache_dir='/models')"
install -m 0644 deploy/gcp/dvr-reranker.service /etc/systemd/system/dvr-reranker.service
systemctl daemon-reload
systemctl enable dvr-reranker.service
systemctl restart dvr-reranker.service
