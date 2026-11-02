#!/usr/bin/env bash
# 서버에서 root로 실행 — ci-deploy.sh(젠킨스) · deploy.sh(내 PC)가 ssh로 이 파일을 넘겨 실행함
#   새 판: sudo bash release.sh <판 이름> <묶음.tgz>   → /var/www/dva-releases/<판 이름>에 풀고 /var/www/dva 링크를 한 번에 바꿈
#   되돌리기: sudo bash release.sh --rollback           → 바로 전 판으로 링크만 바꿈 (빌드 · 업로드 없이 몇 초)
# nginx 설정은 그대로(root /var/www/dva). 링크를 바꾸는 순간부터 새 판이 나가고, 요청 중간에 반쯤 바뀐 파일을 내주는 일이 없음
set -euo pipefail
BASE=${DVA_RELEASES:-/var/www/dva-releases}
LIVE=${DVA_LIVE:-/var/www/dva}
KEEP=5 # 남겨 둘 판 수 (되돌리기용)

mkdir -p "$BASE"
releases() { find "$BASE" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-; }

switch_to() {
  ln -sfn "$1" "$LIVE.next"
  # 처음 한 번: 손으로 올리던 디렉터리를 판 하나로 보관하고 그 자리를 링크로 바꿈
  if [[ -d $LIVE && ! -L $LIVE ]]; then mv "$LIVE" "$BASE/manual-$(date +%Y%m%d%H%M%S)"; fi
  mv -Tf "$LIVE.next" "$LIVE"
  echo "지금 판: $(readlink "$LIVE")"
}

if [[ ${1:-} == --rollback ]]; then
  current=$(readlink -f "$LIVE" || true)
  previous=$(releases | grep -vxF "$current" | head -1 || true)
  [[ -n $previous ]] || { echo "되돌릴 이전 판이 없습니다" >&2; exit 1; }
  switch_to "$previous"
  exit 0
fi

name=${1:?판 이름}
tgz=${2:?묶음 경로}
[[ $name =~ ^[A-Za-z0-9._-]+$ ]] || { echo "판 이름에 쓸 수 없는 글자: $name" >&2; exit 1; }
target=$BASE/$name
rm -rf "$target"
mkdir -p "$target"
tar -xzf "$tgz" -C "$target"
rm -f "$tgz"
[[ -f $target/index.html ]] || { rm -rf "$target"; echo "index.html이 없는 묶음 — 교체하지 않음" >&2; exit 1; }
chmod -R a+rX "$target"
touch "$target" # 판 순서 = 올린 순서 (tar가 폴더 시각을 빌드 당시로 덮어써서 되돌리기 · 정리 순서가 꼬였음)
switch_to "$target"

# 오래된 판 정리 — 지금 판은 지우지 않음
# (지울 판이 없으면 grep이 1을 돌려줘서 || true — 없으면 배포 전체가 실패로 끝났음)
releases | tail -n +$((KEEP + 1)) | { grep -vxF "$target" || true; } | while read -r old; do rm -rf "$old"; done
