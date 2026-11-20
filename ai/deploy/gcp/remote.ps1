param(
    [string]$ScriptPath,
    [string]$ScriptText,
    [string]$Project = '<GCP_PROJECT>',
    [string]$Zone = 'asia-northeast3-a',
    [string]$Name = 'dvr-reranker-l4'
)
$ErrorActionPreference = 'Stop'
if ($ScriptPath) { $ScriptText = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $ScriptPath).Path) }
if (-not $ScriptText) { throw '실행할 스크립트가 필요합니다.' }
$taskScript64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ScriptText.Replace("`r`n", "`n")))
# gcloud.cmd가 중첩 따옴표를 Windows 명령으로 해석하지 않게 한다. 비밀 인수는 보내지 않는다.
$taskCommand = "echo $taskScript64 | base64 -d | sudo bash"
$taskGcloud = 'C:/Users/SSAFY/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd'
& $taskGcloud compute ssh $Name "--project=$Project" "--zone=$Zone" --tunnel-through-iap --quiet "--command=$taskCommand"
if ($LASTEXITCODE -ne 0) { throw 'GPU 서버 원격 작업 실패' }
