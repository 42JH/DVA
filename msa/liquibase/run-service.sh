#!/usr/bin/env bash
set -euo pipefail
service=${1:?Usage: bash run-service.sh SERVICE ACTION IMAGE [PENDING_SHA256]}
action=${2:?Specify validate, update-sql, status, update, preview or apply}
image=${3:?Specify the verified Liquibase image}
expected=${4:-}
case "$service" in customer|order|consultation|delivery|operations) ;; *) exit 2 ;; esac
case "$action" in validate|update-sql|status|update|preview|apply) ;; *) exit 2 ;; esac
if [[ ! "$image" =~ ^docker\.io/library/dva-liquibase:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ ]]; then
  echo 'Invalid image tag' >&2; exit 2
fi
if [[ "$action" == apply && ! "$expected" =~ ^[0-9a-f]{64}$ ]]; then
  echo 'Approved pending-changeset fingerprint is required.' >&2; exit 2
fi
if [[ "$action" == preview || "$action" == apply ]]; then
  command='command: ["/bin/bash", "/liquibase/ci-command.sh"]'
  args="args: [\"$service\", \"$action\", \"$expected\"]"
else
  command=''
  args="args: [\"--changelog-file=$service/db.changelog.xml\", \"$action\"]"
fi
job="lb-${service}-${action}-$(date +%s)-${RANDOM}"
cat <<EOF | sudo -n k3s kubectl create -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: ${job}
  namespace: dva
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 600
  ttlSecondsAfterFinished: 86400
  template:
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      nodeSelector:
        kubernetes.io/os: linux
        kubernetes.io/arch: amd64
      containers:
        - name: liquibase
          image: "${image}"
          imagePullPolicy: Never
          ${command}
          ${args}
          envFrom:
            - secretRef:
                name: ${service}-db
          env:
            - name: LIQUIBASE_COMMAND_URL
              value: "jdbc:postgresql://\$(PGHOST):\$(PGPORT)/\$(PGDATABASE)"
            - name: LIQUIBASE_COMMAND_USERNAME
              value: "\$(PGUSER)"
            - name: LIQUIBASE_COMMAND_PASSWORD
              value: "\$(PGPASSWORD)"
          resources:
            requests: {cpu: 100m, memory: 256Mi}
            limits: {cpu: "1", memory: 768Mi}
EOF
echo "Migration Job: $job"
deadline=$((SECONDS + 620))
while (( SECONDS < deadline )); do
  state=$(sudo -n k3s kubectl -n dva get "job/$job" -o 'jsonpath={.status.succeeded},{.status.failed}')
  if [[ "$state" == 1,* ]]; then
    sudo -n k3s kubectl -n dva logs "job/$job" --all-containers=true
    exit 0
  fi
  if [[ "$state" == *,[1-9]* ]]; then break; fi
  sleep 3
done
sudo -n k3s kubectl -n dva logs "job/$job" --all-containers=true || true
sudo -n k3s kubectl -n dva get pods -l "job-name=$job" -o wide || true
echo "Job failed or timed out: $job. Inspect before retrying; no automatic retry or rollback." >&2
exit 1
