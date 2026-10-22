#!/usr/bin/env bash
set -euo pipefail
service=${1:?Usage: bash run-service.sh SERVICE validate|update-sql|status|update}
action=${2:?Specify validate, update-sql, status or update}
case "$service" in customer|order|consultation|delivery|operations) ;; *) echo 'Unknown service' >&2; exit 2;; esac
case "$action" in validate|update-sql|status|update) ;; *) echo 'Unsupported action' >&2; exit 2;; esac
job="lb-${service}-${action}-$(date +%s)-${RANDOM}"
cat <<EOF | sudo k3s kubectl create -f -
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
      containers:
        - name: liquibase
          image: docker.io/library/dva-liquibase:5.0.4-pg42.7.14
          imagePullPolicy: Never
          args: ["--changelog-file=${service}/db.changelog.xml", "${action}"]
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
if ! sudo k3s kubectl -n dva wait --for=condition=complete "job/$job" --timeout=620s; then
  sudo k3s kubectl -n dva logs "job/$job" --all-containers=true || true
  echo "Migration Job failed or timed out: $job. Inspect before retrying." >&2
  exit 1
fi
sudo k3s kubectl -n dva logs "job/$job"
