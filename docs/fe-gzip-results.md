# 관리자 웹 JS · CSS 압축 (nginx gzip_types) 결과

2026-11-12. 배포된 관리자 웹(https://dva-d109.duckdns.org)을 Lighthouse로 재고, 압축이 빠진 것을 찾아 서버 nginx에서 고친 기록이다. 코드 변경은 없고 서버 설정 3줄이다.

## 증상

Lighthouse(데스크톱, 첫 방문) 성능 점수가 주문 목록 88, FAQ 85였다. 개선 항목 1순위가 "텍스트 압축 사용"으로, 화면마다 JS · CSS를 400~600KB 덜 받을 수 있다고 나왔다.

```
curl -H "Accept-Encoding: gzip" -D - https://dva-d109.duckdns.org/assets/index-DQrPtYgz.js
→ Content-Encoding 없음, 258,982B 그대로
```

## 원인

서버 `/etc/nginx/nginx.conf`에 `gzip on;`은 있지만 `gzip_types` 줄이 Ubuntu 기본값 그대로 주석이었다. `gzip_types`를 정하지 않으면 nginx는 `text/html`만 압축한다. 그래서 `index.html`만 압축되고 화면 무게의 대부분인 `/assets/*.js` · `*.css`는 원본 크기로 나갔다.

## 조치

서버 `/etc/nginx/snippets/dva-routes.conf`의 관리자 웹 블록(`location ^~ /assets/`, `location /`)에만 3줄을 넣었다. 같은 파일의 백엔드 · AI · Jenkins 경로와 `nginx.conf`는 건드리지 않았다(인프라 담당 소유). 현재 블록 사본: `frontend/deploy/nginx-admin-web.conf`.

```nginx
gzip_types text/css application/javascript image/svg+xml application/json;
gzip_vary on;          # 압축본과 원본을 캐시가 섞지 않게
gzip_comp_level 5;     # CPU 대비 압축률이 꺾이는 지점. 파일은 해시 이름이라 브라우저가 30일 캐시
```

순서: 파일 백업(`dva-routes.conf.bak-20261112005525`) → 수정 → `sudo nginx -t` 통과 시에만 `systemctl reload nginx`, 실패하면 백업으로 되돌림.
첫 시도는 셸 변수가 글자 그대로 들어가 `nginx -t`가 `unknown directive "$G"`로 막았고, 백업으로 되돌린 뒤(reload 전이라 운영 영향 없음) awk로 다시 넣었다.

되돌리기: `sudo cp /etc/nginx/snippets/dva-routes.conf.bak-20261112005525 /etc/nginx/snippets/dva-routes.conf && sudo nginx -t && sudo systemctl reload nginx`

## 결과

파일 하나: 메인 JS 258,982B → 81,890B(-68%), CSS 52,095B → 10,907B(-79%). `Content-Encoding: gzip`, `Vary: Accept-Encoding` 확인. 화면 200, `/api/auth/me` 401(로그인 전, 이전과 같음), IP 주소 200.

Lighthouse 전후 (화면마다 3회, 성능 점수 가운데 판의 값):

| 화면 | 점수 | FCP | LCP | 받은 양 |
|---|---|---|---|---|
| 로그인 | 98 → 99 | 0.80 → 0.56초 | 0.96 → 0.74초 | 798 → 479KB |
| 홈 | 96 → 98 | 0.88 → 0.64초 | 1.24 → 1.14초 | 1,099 → 777KB |
| 통화 목록 | 95 → 99 | 0.91 → 0.64초 | 1.31 → 1.00초 | 851 → 524KB |
| 통화 상세 | 94 → 98 | 0.96 → 0.65초 | 1.44 → 1.02초 | 1,043 → 719KB |
| 주문 목록 | 88 → 98 | 1.15 → 0.66초 | 1.86 → 1.11초 | 888 → 516KB |
| FAQ | 85 → 95 | 1.22 → 0.80초 | 1.79 → 1.17초 | 1,038 → 597KB |
| 통계 | 93 → 98 | 0.98 → 0.64초 | 1.60 → 1.01초 | 1,112 → 785KB |
| AI 상담가 | 92 → 98 | 1.01 → 0.71초 | 1.48 → 1.08초 | 1,012 → 564KB |

TBT는 전후 모두 0~5ms, CLS는 0.05 이하. 3회 점수와 모든 수치: `fe-gzip-results/before-summary.json`, `after-summary.json`. FAQ 전후 Lighthouse 원본 보고서: `fe-gzip-results/faqs-before.html`, `faqs-after.html`(브라우저로 열기).

## 측정 조건

- Lighthouse 12, 데스크톱 프리셋(시뮬레이션 회선), 성능 항목만. 화면마다 3회 재고 점수 가운데 판을 씀
- 대상: 배포 주소, 관리자 계정 로그인 상태. 통화 상세는 `/calls/530`
- 측정 시각: 전 2026-11-12 09:42~09:45, 후 09:55~09:58 (KST). 사이에 바뀐 것은 nginx 3줄뿐
- SSAFY PC 네트워크에서 잰 실험실 측정이라 실제 사용자 환경 값은 아님
- 스크립트: `fe-gzip-results/run.mjs` (사용법은 파일 머리)

측정하면서 바로잡은 것 두 가지. 둘 다 처음엔 전 화면 100점이 나와 이상함을 알아챘다.

1. 로그인이 측정 탭에 안 이어짐: Playwright `launch()` + `newContext()`는 따로 떨어진 컨텍스트라, Lighthouse가 같은 Chrome에 연 탭엔 쿠키가 없어 모든 화면이 로그인 화면으로 넘어간 채 측정됐다(`finalDisplayedUrl`이 전부 `/login`). `launchPersistentContext`로 같은 프로필을 쓰게 하고, 로그인 화면으로 넘어가면 측정을 멈추게 했다.
2. 캐시가 남아 두 번째 방문을 잼: 로그인을 지키려고 `disableStorageReset`을 켜면 HTTP 캐시도 남는다. FCP가 0.03초로 나왔다. 매 측정 전에 CDP `Network.clearBrowserCache`로 캐시만 비워(쿠키는 유지) 첫 방문 기준으로 맞췄다.

## 남은 것

- HTTP/2: Lighthouse 추정 0.2~0.7초. `listen 443 ssl` 줄은 백엔드 · AI · Jenkins와 같이 쓰는 server 블록이라 인프라 담당과 정해야 함
- 홈이 불만 통화를 `limit=100`씩 두 번 받음(약 300KB, API라 이번 압축 대상 밖). 개수만 필요하면 백엔드에 개수 조회를 요청
- 화면에서 안 쓰는 JS 200~270KB(FAQ의 마크다운 표시 159KB 등)
