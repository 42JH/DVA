param(
    [string]$Module = 'scripts.search_manual',
    [switch]$RefreshKey,
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$ModuleArgs
)
# 기존 .env를 읽거나 수정하지 않는다. 자식 프로그램에 GPU 접속 정보만 주입한다.
$ErrorActionPreference = 'Stop'
$taskAiRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$taskStatePath = Join-Path $taskAiRoot 'data/private/gcp/state.json'
$taskKeyPath = Join-Path $taskAiRoot 'data/private/gcp/api-key.dpapi'
$taskState = Get-Content -LiteralPath $taskStatePath -Raw -Encoding utf8 | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $taskKeyPath) -or $RefreshKey) {
    $taskKeyLines = & (Join-Path $PSScriptRoot 'remote.ps1') -Project $taskState.project -Zone $taskState.zone -Name $taskState.name -ScriptText 'cut -d= -f2- /etc/dvr-reranker/runtime.conf'
    $taskCandidates = @($taskKeyLines | Where-Object { $_ -match '^[0-9a-f]{64}$' })
    if ($taskCandidates.Count -ne 1) { throw '서버 키를 안전하게 읽지 못했습니다. 값은 출력하지 않습니다.' }
    $taskSecure = ConvertTo-SecureString -String $taskCandidates[0] -AsPlainText -Force
    $taskSecure | ConvertFrom-SecureString | Set-Content -LiteralPath $taskKeyPath -Encoding ascii
    $taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $taskKeyPath /inheritance:r /grant:r "*$($taskSid):(R,W)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '로컬 키 파일 권한 제한 실패' }
    Remove-Variable taskKeyLines,taskCandidates
}
$taskSecure = (Get-Content -LiteralPath $taskKeyPath -Raw).Trim() | ConvertTo-SecureString
$taskPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecure)
$taskOldKey, $taskOldUrl = $env:RAG_RERANKER_API_KEY, $env:RAG_RERANKER_URL
$taskOldEncoding = $env:PYTHONIOENCODING
Push-Location $taskAiRoot
try {
    $env:RAG_RERANKER_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer)
    $env:RAG_RERANKER_URL = $taskState.url
    $env:PYTHONIOENCODING = 'utf-8'
    uv run python -m $Module @ModuleArgs
    if ($LASTEXITCODE -ne 0) { throw 'GPU 연결 프로그램 실행 실패' }
} finally {
    Pop-Location
    $env:RAG_RERANKER_API_KEY, $env:RAG_RERANKER_URL = $taskOldKey, $taskOldUrl
    $env:PYTHONIOENCODING = $taskOldEncoding
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer)
}
