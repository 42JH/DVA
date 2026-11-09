param()
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$container = 'dva-webhook-test-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$testPassword = [guid]::NewGuid().ToString('N')
$names = @('NODE_ENV', 'AI_AGENT_URL', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'PBX_WEBHOOK_TOKEN')
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    & docker run -d --rm --name $container -e "POSTGRES_PASSWORD=$testPassword" -e POSTGRES_DB=dva_webhook_test -p '127.0.0.1::5432' postgres:17-alpine | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot start disposable test PostgreSQL.' }
    $port = & docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' $container
    if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve test database port.' }
    $env:DB_HOST = '127.0.0.1'
    $env:NODE_ENV = 'test'
    $env:AI_AGENT_URL = 'http://127.0.0.1:8000'
    $env:DB_PORT = "$port".Trim()
    $env:DB_USER = 'postgres'
    $env:DB_PASSWORD = $testPassword
    $env:DB_NAME = 'dva_webhook_test'
    Push-Location (Join-Path $repoRoot 'backend')
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw 'Backend build failed.' }
        & node --test test/webhook.integration.test.cjs
        if ($LASTEXITCODE -ne 0) { throw 'Webhook integration tests failed.' }
    } finally { Pop-Location }
} finally {
    & docker rm -f $container 2>$null | Out-Null
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
