#!/bin/bash
# 최초 부팅/드라이버 설치 재부팅을 이어서 처리한다. 비밀값은 출력하지 않는다.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
install -d -m 0755 /opt/dvr-reranker
exec 9>/var/lock/dvr-reranker-bootstrap.lock
flock -n 9 || exit 0
if test -f /opt/dvr-reranker/bootstrap.ready; then
  exit 0
fi
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg python3 openssl
if ! nvidia-smi >/dev/null 2>&1; then
  install -d /opt/dvr-reranker/driver
  cd /opt/dvr-reranker/driver
  if ! test -f cuda_installer.pyz; then
    curl -fsSL https://storage.googleapis.com/compute-gpu-installation-us/installer/latest/cuda_installer.pyz -o cuda_installer.pyz
  fi
  python3 cuda_installer.pyz install_driver --installation-mode=repo --installation-branch=prod
  if ! nvidia-smi >/dev/null 2>&1; then
    reboot
    exit 0
  fi
fi
if ! command -v docker >/dev/null; then
  apt-get install -y --no-install-recommends docker.io
fi
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list |
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' > /etc/apt/sources.list.d/nvidia-container-toolkit.list
apt-get update
apt-get install -y --no-install-recommends nvidia-container-toolkit
nvidia-ctk runtime configure --runtime=docker
systemctl enable docker
systemctl restart docker
install -d -m 0700 /etc/dvr-reranker
if ! test -f /etc/dvr-reranker/runtime.conf; then
  umask 077
  printf 'RAG_RERANKER_API_KEY=' > /etc/dvr-reranker/runtime.conf
  openssl rand -hex 32 >> /etc/dvr-reranker/runtime.conf
fi
install -d -o 10001 -g 10001 -m 0755 /opt/dvr-reranker/models
touch /opt/dvr-reranker/bootstrap.ready
echo 'dvr-reranker bootstrap ready'
