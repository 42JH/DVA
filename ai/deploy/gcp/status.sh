#!/bin/bash
set -eu
if test -f /opt/dvr-reranker/bootstrap.ready; then
  echo BOOTSTRAP_READY
else
  echo BOOTSTRAP_INSTALLING
fi
nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used --format=csv,noheader 2>/dev/null || true
systemctl is-active dvr-reranker.service 2>/dev/null || true
systemctl is-active dvr-reranker-proxy.service 2>/dev/null || true
