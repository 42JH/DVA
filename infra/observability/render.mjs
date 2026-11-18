import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 알림에는 고정된 요약과 Grafana 링크만 포함한다. 로그/라벨 전체를 직렬화하지 않는다.
export const mattermostPayload =
  '{{ coll.Dict "text" (tmpl.Exec "dva.message" .) | data.ToJSON }}';
const messageTemplate = `{{ define "dva.message" }}[장애] {{ .CommonLabels.service }} / {{ .CommonLabels.incident }}
{{ range .Alerts.Firing }}{{ if eq .Labels.alertname "DatasourceError" }}보안 탐지 조회에 실패했습니다. Grafana에서 수집 상태와 조회 예산을 확인하세요.{{ else }}{{ .Annotations.summary }}{{ end }}
발생 시각: {{ .StartsAt | tz "Asia/Seoul" | date "2006-01-02 15:04:05 MST" }}
{{ end }}상세 확인: {{ .ExternalURL }}d/dva-operations{{ end }}`;

export const checks = [
  [
    "backend_down",
    "backend",
    '1 - max(probe_success{job="service_probe",service="backend"})',
    "1m",
    "백엔드 상태 확인에 1분 이상 실패했습니다.",
  ],
  [
    "database_down",
    "database",
    'max((1 - dva_database_up) and on(job,instance) (up{job="backend"} == 1)) or vector(0)',
    "1m",
    "DB 연결 확인에 1분 이상 실패했습니다.",
  ],
  [
    "nginx_down",
    "nginx",
    '1 - max(probe_success{job="service_probe",service="nginx"})',
    "1m",
    "웹 서버 상태 확인에 1분 이상 실패했습니다.",
  ],
  [
    "submission_failed",
    "backend",
    'max(dva_orders_attention{status="SUBMISSION_FAILED"}) or vector(0)',
    "0s",
    "디버 접수에 실패한 결제 완료 주문이 있습니다. 관리자 재접수를 확인하세요.",
  ],
  [
    "submission_stalled",
    "backend",
    "max(dva_orders_stale_submitting) or vector(0)",
    "0s",
    "접수 처리 중인 상태가 1분 넘게 유지된 주문이 있습니다.",
  ],
  [
    "submission_server_error",
    "backend",
    "sum(increase(dva_submission_http_errors_total[5m])) or vector(0)",
    "0s",
    "최근 5분 동안 접수 API에서 서버 오류가 발생했습니다.",
  ],
];

const authenticationLog =
  '{service="backend",environment="production"} | json event="event",authType="authType",reason="reason"';
const loginFailures = `${authenticationLog},accountKey="accountKey",sourceKey="sourceKey" | __error__="" | event="authentication_failure" | authType="admin_login" | reason="invalid_credentials"`;
// Alloy keeps only service/environment, so each parsed account/source pair is one logical series.
export const securityChecks = [
  [
    "login_account_failures",
    "backend",
    `max(count_over_time(${loginFailures} | accountKey!="" | drop sourceKey [15m])) >= bool 5 or vector(0)`,
    "0s",
    "최근 15분 동안 같은 계정의 로그인 인증이 5회 이상 실패했습니다.",
  ],
  [
    "login_source_accounts",
    "backend",
    `max(count by (sourceKey) (count_over_time(${loginFailures} | accountKey!="" | sourceKey!="" [5m]))) >= bool 10 or vector(0)`,
    "0s",
    "최근 5분 동안 같은 출처에서 서로 다른 계정 10개 이상의 로그인 인증이 실패했습니다.",
  ],
  [
    "login_failure_burst",
    "backend",
    `sum(count_over_time(${authenticationLog} | __error__="" | event="authentication_failure" | authType="admin_login" | reason="invalid_credentials" [5m])) >= bool 30 or vector(0)`,
    "0s",
    "최근 5분 동안 전체 로그인 인증이 30회 이상 실패했습니다.",
  ],
  [
    "ai_authentication_failures",
    "backend",
    `max(sum by (authType) (count_over_time(${authenticationLog} | __error__="" | event="authentication_failure" | authType=~"ai_business|ai_persona|ai_insights" | reason="invalid_service_token" [5m]))) >= bool 5 or vector(0)`,
    "0s",
    "최근 5분 동안 같은 종류의 AI 서비스 인증이 5회 이상 실패했습니다.",
  ],
];

export function resources(webhook = "", { allowHttp = false } = {}) {
  if (webhook) {
    const url = new URL(webhook);
    if (
      (!allowHttp && url.protocol !== "https:") ||
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/hooks\/[A-Za-z0-9_-]+$/.test(url.pathname)
    )
      throw new Error("Invalid Mattermost incoming webhook URL");
  }
  return {
    apiVersion: 1,
    contactPoints: [
      {
        orgId: 1,
        name: "mattermost-private",
        receivers: [
          {
            uid: "mattermost-private",
            type: "webhook",
            disableResolveMessage: true,
            settings: {
              url: webhook || "http://127.0.0.1:1/not-configured",
              httpMethod: "POST",
              maxAlerts: "10",
              payload: { template: mattermostPayload },
            },
          },
        ],
      },
    ],
    templates: [{ orgId: 1, name: "dva-message", template: messageTemplate }],
    policies: [
      {
        orgId: 1,
        receiver: "mattermost-private",
        group_by: ["service", "incident"],
        group_wait: "30s",
        group_interval: "5m",
        repeat_interval: "24h",
      },
    ],
    groups: [
      {
        orgId: 1,
        name: "dva-functional-failures",
        folder: "DVA",
        interval: "30s",
        rules: [
          ...checks.map((row, index) => [
            ...row,
            "prometheus",
            [1, 2, 3, 5, 5, 6][index],
          ]),
          ...securityChecks.map((row) => [...row, "loki", 23]),
        ].map(
          ([uid, service, expr, duration, summary, datasource, panelId]) => ({
            uid: `dva_${uid}`,
            title: uid,
            condition: "B",
            for: duration,
            noDataState: "OK",
            execErrState: datasource === "loki" ? "Error" : "OK",
            isPaused: !webhook,
            annotations: {
              summary,
              __dashboardUid__: "dva-operations",
              __panelId__: String(panelId),
            },
            labels: { service, incident: uid },
            data: [
              {
                refId: "A",
                relativeTimeRange: { from: 600, to: 0 },
                datasourceUid: datasource,
                model: {
                  refId: "A",
                  expr,
                  instant: true,
                  range: false,
                  intervalMs: 15000,
                  maxDataPoints: 43200,
                  ...(datasource === "loki"
                    ? { queryType: "instant", editorMode: "code" }
                    : {}),
                },
              },
              {
                refId: "B",
                relativeTimeRange: { from: 0, to: 0 },
                datasourceUid: "__expr__",
                model: {
                  refId: "B",
                  type: "classic_conditions",
                  conditions: [
                    {
                      evaluator: { params: [0], type: "gt" },
                      operator: { type: "and" },
                      query: { params: ["A"] },
                      reducer: { params: [], type: "last" },
                      type: "query",
                    },
                  ],
                },
              },
            ],
          }),
        ),
      },
    ],
  };
}

export function render(destination, environment = process.env) {
  const {
    OBS_DATA_DIR: data,
    OBS_RUNTIME_DIR: runtime,
    GRAFANA_ADMIN_USER: user,
    GRAFANA_ADMIN_PASSWORD: password,
    GRAFANA_ROOT_URL: root,
  } = environment;
  if (
    data !== "/srv/dva-observability/data" ||
    runtime !== "/srv/dva-observability/runtime"
  )
    throw new Error("Use dedicated observability storage paths");
  if (!user || !/^[a-zA-Z0-9_.-]{3,64}$/.test(user))
    throw new Error("Invalid Grafana administrator name");
  if (
    !password ||
    password.length < 24 ||
    password.startsWith("REPLACE_") ||
    /[\r\n\0]/.test(password)
  )
    throw new Error(
      "Set a new Grafana administrator password (at least 24 characters)",
    );
  const url = new URL(root);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/grafana/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Grafana URL must be https://host/grafana/");
  const value = resources(environment.MATTERMOST_WEBHOOK_URL || "");
  mkdirSync(resolve(destination, "alerting"), { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries({
    "alerting/resources.json": JSON.stringify(value, null, 2),
    "admin-password": password,
    "data-dir": data,
    "runtime-dir": runtime,
  }))
    writeFileSync(resolve(destination, name), content, { mode: 0o600 });
  // 비밀값 대신 적용 여부만 출력한다.
  console.log(
    value.groups[0].rules[0].isPaused
      ? "Prepared: alert rules PAUSED (webhook not configured)."
      : "Prepared: private-channel alert rules enabled.",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    render(resolve(process.argv[2] || ".runtime"));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Invalid observability settings",
    );
    process.exitCode = 1;
  }
}
