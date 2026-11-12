# MSA 관측·확장·장애 점검

[S15P31D109-128](https://ssafy.atlassian.net/browse/S15P31D109-128)의 MSA 전용 구성이다. `dva`의 operations, customer, consultation, delivery, order Pod를 `dva-observability`의 Prometheus·Grafana·Loki·Alloy에 연결한다. 적용·측정 결과는 [검증 결과](RESULTS.md)에 기록한다.

## 수집 범위와 권한

- Prometheus는 서비스 주소 대신 HTTP 포트가 있는 개별 Pod의 `/internal/metrics`를 읽는다. 헬스 체크를 제외한 요청량·5xx·p95, DB 연결/대기, Outbox 대기·재시도·가장 오래된 미전달 시간을 서비스별로 볼 수 있다. DB 또는 Outbox 읽기에 실패하면 성공 지표를 0으로 내보내고, 누락된 이벤트 건수를 0건으로 표시하지 않는다.
- CPU·메모리는 kubelet의 `/metrics/resource`를 TLS로 조회한다. Prometheus 계정에는 노드 검색과 `nodes/metrics` 읽기, Alloy 계정에는 `dva` Pod 검색과 로그 읽기 권한을 부여한다. HPA는 Metrics Server의 리소스 지표를 사용한다. [Kubelet 권한](https://kubernetes.io/docs/reference/access-authn-authz/kubelet-authn-authz/) · [HPA 리소스 지표](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/)
- Alloy는 Kubernetes API에서 MSA 컨테이너 로그를 받아 허용된 필드로 JSON을 다시 만든다. Loki로 보내는 필드는 검증된 요청 ID·이벤트 ID, HTTP 메서드·코드·시간, 전송 결과다. 요청 ID는 라벨로 쓰지 않는다. 이벤트 송신자는 같은 ID를 수신 요청에 전달하므로 Grafana에서 상담 송신과 주문 수신을 연결할 수 있다. [Alloy Kubernetes 로그 수집](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.kubernetes/)
- 앱 지표와 관측 도구는 클러스터 내부 경로로 제공한다. Grafana는 인증을 사용하고 port-forward로 접속한다. Loki는 Alloy와 Grafana에서만, Prometheus는 Grafana에서만 Pod 네트워크 접근을 허용한다.
- Prometheus 보관 기준은 7일 또는 2 GB, Loki는 7일·0.05 MiB/s·최대 로그 2 KiB다. WAL·인덱스·Local Path 저장소 특성상 이 값으로 디스크 사용량이 고정되지는 않는다. 노드 디스크와 각 PVC 실제 사용량을 확인한다.

## 관측 구성 적용

먼저 이 커밋이 포함된 MSA 앱 이미지가 배포됐는지 확인한다. 아래 명령은 MSA k3s 컨텍스트에서 저장소 루트 기준으로 실행한다. `dva` 네임스페이스와 `local-path` StorageClass가 필요하다.

```bash
kubectl config current-context
kubectl get ns dva
kubectl get storageclass local-path
kubectl create namespace dva-observability --dry-run=client -o yaml | kubectl apply -f -
```

첫 적용 때 Grafana 관리자 비밀번호를 Kubernetes Secret에 저장한다.

```bash
read -r -s -p 'Grafana password: ' grafana_password
printf '%s' "$grafana_password" | kubectl -n dva-observability create secret generic msa-grafana-admin --from-file=password=/dev/stdin
unset grafana_password
kubectl apply --dry-run=server -k msa/observability
kubectl apply -k msa/observability
kubectl -n dva-observability get deploy,pvc
kubectl -n dva-observability port-forward svc/grafana 3000:3000 --address 127.0.0.1
```

Grafana에서 `DVA MSA 운영 상태`를 연다. `수집 가능한 Pod`에 다섯 서비스가 보이는지 확인한다. 트래픽을 받은 서비스의 요청량과 지연이 나타난다. 지표가 없으면 Prometheus의 대상 상태를 먼저 보고, `dva_database_up`과 `dva_outbox_metrics_success`로 DB와 Outbox 조회 상태를 구분한다.

수집 상태는 최근 75초의 샘플로 판단한다. 대상이 내려간 경우 Prometheus 재시작 전의 정상 샘플이 5분 동안 조회되더라도 장애를 숨기지 않는다.

## 주문 확장 시험과 연결 예산

합성 DB를 붙인 격리 클러스터에서 같은 읽기 요청을 보내면서 Pod 1개 기준의 요청량·p95·5xx와 `kubectl top pods`를 기록한다. 주문 Pod를 2개로 늘려 양쪽의 HTTP 카운터 증가를 확인하고 1개로 복귀한 뒤, 별도 HPA 매니페스트를 적용한다.

```bash
kubectl get apiservice v1beta1.metrics.k8s.io
kubectl -n dva top pods -l app=dva-order
kubectl -n dva scale deployment/order --replicas=2
kubectl -n dva rollout status deployment/order
kubectl -n dva scale deployment/order --replicas=1
kubectl apply -f msa/observability/order-hpa.yaml
kubectl -n dva get hpa order -w
```

동일한 주문 GET 부하를 올려 HPA가 2개로 확장되는 시각, 부하를 제거해 1개로 복귀하는 시각, 요청 오류와 지연을 기록한다. 초기 시험값은 CPU request의 60%, 최대 2 Pod, 축소 안정화 60초다. `order-hpa.yaml`은 관측 스택 적용에 포함하지 않는다. 주문 Deployment에 `replicas: 1`이 선언돼 있으므로 운영 상시 적용 여부는 배포 시 replica 관리까지 대조한 뒤 결정한다.

격리 시험을 마치면 HPA를 해제하고 기준 Pod 수로 돌린다.

```bash
kubectl -n dva delete hpa order
kubectl -n dva scale deployment/order --replicas=1
```

현재 Pod별 최대 연결은 operations·delivery가 5개, customer·consultation·order가 6개다. 참조 풀까지 포함한 기본 상한은 28개다. 주문 2개 시험은 34개, 순차 앱 배포에서 추가 Pod 한 개를 계산하면 최대 40개다. 운영 PostgreSQL 상한 60개 중 예약 3개를 제외하면 57개이며, 이 계산에는 백업·관리·마이그레이션 세션과 종료 중 Pod를 위한 여유가 필요하다. 적용 직전 사용량과 가용 슬롯을 다시 측정한다.

## 장애 점검

| 격리 시험 | 관측과 복구 판정 |
| --- | --- |
| 주문 Pod 종료 | 이전 Pod UID와 교체 UID, Ready 복구까지 걸린 시간, 그 사이 읽기 응답을 기록한다. |
| 내부 인증 호출 실패 | operations를 중단한 동안 주문의 500 응답과 `DvaMsaNoScrape`를 확인한다. operations 재기동 뒤 주문 200과 경보 해제를 확인한다. |
| 롤링 배포 실패 | 기존 `msa/deploy/tests/integration_app_rollout.py`로 readiness 실패를 유도하고 직전 이미지 복원과 연속 health 응답을 확인한다. |
| 이벤트 수신 장애 | 주문의 종료 중 Pod도 사라져 Service에 연결되지 않는 시점부터 상담 Outbox의 미전달·재시도·지연을 관찰한다. 복구 뒤 Inbox에 이벤트 1건과 업무 반영 1회가 남는지 비교한다. 같은 이벤트를 재전달해 재실행이 없는지 확인한다. |

운영 이상 시 Grafana에서 서비스와 시간 범위를 좁히고 `requestId` 또는 `eventId`로 관련 로그를 찾는다. Pod Ready, DB 연결, Outbox 지연을 확인한 뒤 배포 문제는 기존 MSA 배포의 복원 절차로 처리한다. 관측 설정 문제는 이전 검증 버전의 이 디렉터리를 적용해 복원하고 PVC를 보존한다. 단일 노드 전체 중단은 이 작업의 Pod 복구 범위 밖이다.
