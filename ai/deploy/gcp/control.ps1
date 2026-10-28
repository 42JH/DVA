param(
    [ValidateSet('Start','Stop','Status')]
    [string]$Action = 'Status'
)
$ErrorActionPreference = 'Stop'
$taskGcloud = 'C:/Users/SSAFY/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd'
$taskAiRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$taskState = Get-Content -LiteralPath (Join-Path $taskAiRoot 'data/private/gcp/state.json') -Raw -Encoding utf8 | ConvertFrom-Json
$taskBase = @("--project=$($taskState.project)", "--zone=$($taskState.zone)", '--quiet')
if ($Action -eq 'Stop') {
    & $taskGcloud compute instances stop $taskState.name @taskBase
} elseif ($Action -eq 'Start') {
    $taskVm = & $taskGcloud compute instances describe $taskState.name @taskBase --format=json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'VM 상태 조회 실패' }
    if ($taskVm.status -eq 'RUNNING') { Write-Output '이미 실행 중입니다. 현재 타이머를 연장하지 않습니다.'; exit 0 }
    if ($taskVm.status -ne 'TERMINATED') { throw '현재 시작/중지 중입니다. 상태가 바뀐 후 재시도하세요.' }
    & $taskGcloud compute instances set-scheduling $taskState.name @taskBase --max-run-duration=15m --instance-termination-action=STOP --maintenance-policy=TERMINATE --no-restart-on-failure
    if ($LASTEXITCODE -ne 0) { throw '15분 중지 설정 실패. VM을 시작하지 않습니다.' }
    & $taskGcloud compute instances start $taskState.name @taskBase
} else {
    & $taskGcloud compute instances describe $taskState.name @taskBase --format='json(name,status,scheduling.maxRunDuration,scheduling.instanceTerminationAction)'
}
if ($LASTEXITCODE -ne 0) { throw 'VM 제어 실패' }
