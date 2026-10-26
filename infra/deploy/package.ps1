param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9][a-z0-9.-]{0,79}$')]
    [string]$Version
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$releaseDir = Join-Path $repoRoot ".deploy/$Version"
if (Test-Path -LiteralPath $releaseDir) {
    throw "Release already exists: $releaseDir. Use a new version."
}

function Invoke-Docker {
    param([string[]]$DockerArgs)
    & docker @DockerArgs
    if ($LASTEXITCODE -ne 0) { throw "Docker failed: $($DockerArgs[0])" }
}

function Write-Utf8 {
    param([string]$Path, [string]$Content)
    [IO.File]::WriteAllText($Path, $Content.Replace("`r`n", "`n"), [Text.UTF8Encoding]::new($false))
}

Push-Location $repoRoot
try {
    Invoke-Docker -DockerArgs @('version')
    Invoke-Docker -DockerArgs @('build', '--platform', 'linux/amd64', '-t', "dva-backend:$Version", './backend')
    Invoke-Docker -DockerArgs @('pull', '--platform', 'linux/amd64', 'postgres:17-alpine')
    Invoke-Docker -DockerArgs @('pull', '--platform', 'linux/amd64', 'nginx:stable-alpine')
    Invoke-Docker -DockerArgs @('tag', 'postgres:17-alpine', "dva-postgres:$Version")
    Invoke-Docker -DockerArgs @('tag', 'nginx:stable-alpine', "dva-nginx:$Version")

    $images = @("dva-backend:$Version", "dva-postgres:$Version", "dva-nginx:$Version")
    foreach ($image in $images) {
        $platform = & docker image inspect --format '{{.Os}}/{{.Architecture}}' $image
        if ($LASTEXITCODE -ne 0 -or $platform -ne 'linux/amd64') {
            throw "Expected linux/amd64 image: $image"
        }
    }

    New-Item -ItemType Directory -Path (Join-Path $releaseDir 'infra/nginx') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $releaseDir 'infra/database') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $releaseDir 'backend/migrations') -Force | Out-Null
    Invoke-Docker -DockerArgs (@('image', 'save', '--output', (Join-Path $releaseDir 'images.tar')) + $images)
    $hash = (Get-FileHash -LiteralPath (Join-Path $releaseDir 'images.tar') -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Utf8 -Path (Join-Path $releaseDir 'images.tar.sha256') -Content "$hash  images.tar`n"
    Write-Utf8 -Path (Join-Path $releaseDir 'release.env') -Content @"
BACKEND_IMAGE=dva-backend:$Version
POSTGRES_IMAGE=dva-postgres:$Version
NGINX_IMAGE=dva-nginx:$Version

"@
    $releaseFiles = @('compose.prod.yaml', 'release.env', 'deploy.sh', 'infra/nginx/default.prod.conf',
        'infra/database/migrate.sh', 'infra/database/verify.sql')
    foreach ($file in @('compose.prod.yaml', 'infra/nginx/default.prod.conf', 'infra/database/migrate.sh', 'infra/database/verify.sql')) {
        Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination (Join-Path $releaseDir $file)
    }
    Write-Utf8 -Path (Join-Path $releaseDir 'deploy.sh') -Content ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'deploy.sh')))
    foreach ($migration in Get-ChildItem -LiteralPath (Join-Path $repoRoot 'backend/migrations') -Filter '???-*.sql' -File) {
        $relativePath = 'backend/migrations/' + $migration.Name
        Copy-Item -LiteralPath $migration.FullName -Destination (Join-Path $releaseDir $relativePath)
        $releaseFiles += $relativePath
    }
    $manifest = foreach ($file in $releaseFiles) {
        $fileHash = (Get-FileHash -LiteralPath (Join-Path $releaseDir $file) -Algorithm SHA256).Hash.ToLowerInvariant()
        "$fileHash  $file"
    }
    Write-Utf8 -Path (Join-Path $releaseDir 'release-files.sha256') -Content (($manifest -join "`n") + "`n")
    Write-Host "Release ready: $releaseDir"
    Write-Host 'Transfer this directory only. Production secrets stay on the server.'
}
finally {
    Pop-Location
}
