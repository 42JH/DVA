param([switch]$KeepContainer)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$containerName = 'dva-db-129-check'
function Invoke-Docker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "Docker command failed (exit $LASTEXITCODE)." }
}
$existing = & docker ps -a --filter "name=^/$containerName`$" --format '{{.Names}}'
if ($LASTEXITCODE -ne 0) { throw 'Docker is unavailable.' }
if ($existing) { throw "Container $containerName already exists. Inspect it before running a fresh check." }
$created = $false
try {
    Invoke-Docker run --detach --name $containerName --network none --tmpfs /var/lib/postgresql/data `
        -e POSTGRES_PASSWORD=local-validation-only -e POSTGRES_USER=dva -e POSTGRES_DB=monolith_db postgres:17-alpine
    $created = $true
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        & docker exec $containerName pg_isready -U dva -d monolith_db *> $null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Temporary PostgreSQL did not become ready.' }
    Invoke-Docker exec $containerName mkdir -p /tmp/dva129/backend /tmp/dva129/infra /tmp/dva129/testbin
    Invoke-Docker cp (Join-Path $repoRoot 'backend/migrations') "${containerName}:/tmp/dva129/backend/"
    Invoke-Docker cp (Join-Path $repoRoot 'infra/database') "${containerName}:/tmp/dva129/infra/"
    Invoke-Docker cp (Join-Path $repoRoot 'backend/database-tests/docker') "${containerName}:/tmp/dva129/testbin/docker"
    Invoke-Docker cp (Join-Path $repoRoot 'backend/database-tests/monolith-check.sql') "${containerName}:/tmp/dva129/check.sql"
    Invoke-Docker cp (Join-Path $repoRoot 'backend/database-tests/runner-check.sh') "${containerName}:/tmp/dva129/runner-check.sh"
    Invoke-Docker cp (Join-Path $repoRoot 'backend/database-tests/creation-upgrade-check.sh') "${containerName}:/tmp/dva129/creation-upgrade-check.sh"
    Invoke-Docker cp (Join-Path $repoRoot 'backend/database-tests/membership-upgrade-check.sh') "${containerName}:/tmp/dva129/membership-upgrade-check.sh"
    Invoke-Docker cp (Join-Path $repoRoot 'backend/database-tests/order-source-upgrade-check.sh') "${containerName}:/tmp/dva129/order-source-upgrade-check.sh"
    Invoke-Docker exec $containerName chmod +x /tmp/dva129/testbin/docker
    Invoke-Docker exec $containerName sh /tmp/dva129/runner-check.sh
} finally {
    if ($created -and -not $KeepContainer) {
        # Only the container just created above; no named volumes or host mounts.
        & docker rm -f $containerName | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Warning "Could not remove test container $containerName." }
    }
}
