param(
    [string]$Project = 'dvr-rerank',
    [string]$Gcloud = 'C:/Users/SSAFY/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd'
)
$ErrorActionPreference = 'Stop'
$taskAiRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$taskStatePath = Join-Path $taskAiRoot 'data/private/gcp'
New-Item -ItemType Directory -Force -Path $taskStatePath | Out-Null

function Invoke-TaskGcloud {
    param([string[]]$Arguments)
    $taskResponse = & $Gcloud @Arguments
    if ($LASTEXITCODE -ne 0) { throw "gcloud 실패: $($Arguments[0..1] -join ' ')" }
    return $taskResponse
}

# 기존 자원을 임의로 덮어쓰지 않는다. 실패 후 이어갈 때도 상태를 먼저 확인한다.
$taskInstances = Invoke-TaskGcloud -Arguments @('compute','instances','list',"--project=$Project",'--format=json') | ConvertFrom-Json
if ($taskInstances.Count -gt 0) { throw '기존 VM이 있습니다. 배포 상태를 확인한 후 이어가세요.' }
$taskBilling = Invoke-TaskGcloud -Arguments @('billing','projects','describe',$Project,'--format=json') | ConvertFrom-Json
$taskBillingId = $taskBilling.billingAccountName -replace '^billingAccounts/',''
$taskAccount = Invoke-TaskGcloud -Arguments @('billing','accounts','describe',$taskBillingId,'--format=json') | ConvertFrom-Json
if ($taskAccount.currencyCode -ne 'KRW') { throw '원화 결제 계정이 아닙니다. 예산 환산을 재검토하세요.' }

# 토큰은 API 인증에만 쓰고 출력하거나 파일로 저장하지 않는다.
$taskToken = (Invoke-TaskGcloud -Arguments @('auth','print-access-token','--quiet')).Trim()
$taskHeaders = @{ Authorization = "Bearer $taskToken"; 'X-Goog-User-Project' = $Project }
try {
    $taskCatalog = Invoke-RestMethod -Uri 'https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus?currencyCode=KRW&pageSize=1' -Headers $taskHeaders
    $taskFx = [double]$taskCatalog.skus[0].pricingInfo[-1].currencyConversionRate
} finally {
    $taskHeaders.Clear()
    Remove-Variable taskToken
}
if ($taskFx -lt 1000 -or $taskFx -gt 3000) { throw '예상 범위 밖의 환산율입니다. 확인이 필요합니다.' }
$taskKrw = [math]::Floor(250 * $taskFx)
$taskProjectNumber = (Invoke-TaskGcloud -Arguments @('projects','describe',$Project,'--format=value(projectNumber)')).Trim()
$taskBudgets = Invoke-TaskGcloud -Arguments @('billing','budgets','list',"--billing-account=$taskBillingId",'--format=json') | ConvertFrom-Json
$taskBudget = @($taskBudgets | Where-Object { $_.displayName -eq 'dvr-rerank-credit-250usd' })
if ($taskBudget.Count -eq 0) {
    $taskBudget = Invoke-TaskGcloud -Arguments @('billing','budgets','create',"--billing-account=$taskBillingId",
        '--display-name=dvr-rerank-credit-250usd',"--budget-amount=${taskKrw}KRW","--filter-projects=projects/$taskProjectNumber",
        '--credit-types-treatment=exclude-all-credits','--start-date=2026-10-27',
        '--threshold-rule=percent=0.5','--threshold-rule=percent=0.8','--threshold-rule=percent=0.9',
        '--threshold-rule=percent=1.0','--quiet','--format=json') | ConvertFrom-Json
}
Write-Output "BUDGET_READY KRW=$taskKrw FX=$taskFx"

$taskNetworks = Invoke-TaskGcloud -Arguments @('compute','networks','list',"--project=$Project",'--format=value(name)')
if ('dvr-reranker-net' -notin $taskNetworks) {
    Invoke-TaskGcloud -Arguments @('compute','networks','create','dvr-reranker-net',"--project=$Project",'--subnet-mode=custom','--quiet') | Out-Null
}
$taskSubnets = Invoke-TaskGcloud -Arguments @('compute','networks','subnets','list',"--project=$Project",'--format=value(name)')
if ('dvr-reranker-subnet' -notin $taskSubnets) {
    Invoke-TaskGcloud -Arguments @('compute','networks','subnets','create','dvr-reranker-subnet',"--project=$Project",'--network=dvr-reranker-net','--region=asia-northeast3','--range=10.31.0.0/24','--quiet') | Out-Null
}
$taskRules = Invoke-TaskGcloud -Arguments @('compute','firewall-rules','list',"--project=$Project",'--format=value(name)')
if ('dvr-reranker-iap-ssh' -notin $taskRules) {
    Invoke-TaskGcloud -Arguments @('compute','firewall-rules','create','dvr-reranker-iap-ssh',"--project=$Project",'--network=dvr-reranker-net','--allow=tcp:22','--source-ranges=35.235.240.0/20','--target-tags=dvr-reranker','--quiet') | Out-Null
}
if ('dvr-reranker-web' -notin $taskRules) {
    Invoke-TaskGcloud -Arguments @('compute','firewall-rules','create','dvr-reranker-web',"--project=$Project",'--network=dvr-reranker-net','--allow=tcp:80,tcp:443','--source-ranges=0.0.0.0/0','--target-tags=dvr-reranker','--quiet') | Out-Null
}
$taskAddresses = Invoke-TaskGcloud -Arguments @('compute','addresses','list',"--project=$Project",'--format=value(name)')
if ('dvr-reranker-ip' -notin $taskAddresses) {
    Invoke-TaskGcloud -Arguments @('compute','addresses','create','dvr-reranker-ip',"--project=$Project",'--region=asia-northeast3','--network-tier=STANDARD','--quiet') | Out-Null
}
$taskIp = (Invoke-TaskGcloud -Arguments @('compute','addresses','describe','dvr-reranker-ip',"--project=$Project",'--region=asia-northeast3','--format=value(address)')).Trim()
$taskZone = 'asia-northeast3-a'
$taskVm = 'dvr-reranker-l4'
$taskState = @{project=$Project; name=$taskVm; zone=$taskZone; ip=$taskIp; url="https://${taskIp}.sslip.io";
    budgetUsd=250; budgetKrw=$taskKrw; currencyConversionRate=$taskFx; runtimeAfterSetupSeconds=900; state='creating'}
$taskState | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskStatePath 'state.json') -Encoding utf8
Invoke-TaskGcloud -Arguments @('compute','instances','create',$taskVm,"--project=$Project","--zone=$taskZone",'--machine-type=g2-standard-4',
    '--image=ubuntu-2204-jammy-v20261021','--image-project=ubuntu-os-cloud','--boot-disk-size=60GB','--boot-disk-type=pd-balanced',
    '--subnet=dvr-reranker-subnet',"--address=$taskIp",'--network-tier=STANDARD','--tags=dvr-reranker',
    '--no-service-account','--no-scopes','--maintenance-policy=TERMINATE','--no-restart-on-failure',
    '--no-shielded-secure-boot','--shielded-vtpm','--shielded-integrity-monitoring',
    '--metadata=block-project-ssh-keys=TRUE,enable-oslogin=FALSE',
    "--metadata-from-file=startup-script=$PSScriptRoot/bootstrap.sh",'--max-run-duration=4h',
    '--instance-termination-action=STOP','--labels=app=dvr-reranker,purpose=rag-test','--quiet','--format=json') | Out-Null
$taskState.state = 'provisioned'
$taskState | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskStatePath 'state.json') -Encoding utf8
Write-Output "VM_CREATED $taskVm $taskZone $taskIp"
