param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9][a-z0-9.-]{0,79}$')]
    [string]$Version,

    [Parameter(Mandatory = $true)]
    [string]$IdentityFile,

    [ValidatePattern('^[a-z_][a-z0-9_-]*$')]
    [string]$SshUser = 'ubuntu',

    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$releaseDir = Join-Path $repoRoot ".deploy/$Version"
$knownHosts = Join-Path $PSScriptRoot 'known_hosts'
$server = "$SshUser@13.209.59.180"
$remoteRoot = '/home/ubuntu/dva-deploy'
$sshExe = Join-Path $env:WINDIR 'System32/OpenSSH/ssh.exe'
$scpExe = Join-Path $env:WINDIR 'System32/OpenSSH/scp.exe'

foreach ($required in @($IdentityFile, $knownHosts, $sshExe, $scpExe,
    (Join-Path $releaseDir 'images.tar'), (Join-Path $releaseDir 'images.tar.sha256'),
    (Join-Path $releaseDir 'deploy.sh'), (Join-Path $releaseDir 'compose.prod.yaml'),
    (Join-Path $releaseDir 'release.env'), (Join-Path $releaseDir 'infra/nginx/default.prod.conf'))) {
    if (!(Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing required file: $required" }
}
$expectedHash = ([IO.File]::ReadAllText((Join-Path $releaseDir 'images.tar.sha256')) -split '\s+')[0]
$actualHash = (Get-FileHash -LiteralPath (Join-Path $releaseDir 'images.tar') -Algorithm SHA256).Hash
if ($expectedHash -notmatch '^[0-9a-fA-F]{64}$' -or $expectedHash -ne $actualHash) {
    throw 'Release archive checksum mismatch. Nothing was transferred.'
}

function Invoke-Native {
    param([string]$Program, [string[]]$ProgramArgs)
    & $Program @ProgramArgs
    if ($LASTEXITCODE -ne 0) { throw "Command failed: $([IO.Path]::GetFileName($Program)), exit $LASTEXITCODE" }
}

# Jenkins' generated key file may inherit broad Windows ACLs. Use an owner-only
# temporary copy outside the workspace; never change the original PEM/credential.
$keyDir = Join-Path ([IO.Path]::GetTempPath()) ('dva-ssh-' + [guid]::NewGuid().ToString('N'))
$privateKey = Join-Path $keyDir 'identity.pem'
try {
    New-Item -ItemType Directory -Path $keyDir | Out-Null
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $directoryAcl = [Security.AccessControl.DirectorySecurity]::new()
    $directoryAcl.SetOwner($owner)
    $directoryAcl.SetAccessRuleProtection($true, $false)
    $directoryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $owner, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $keyDir -AclObject $directoryAcl
    Copy-Item -LiteralPath $IdentityFile -Destination $privateKey
    $keyAcl = [Security.AccessControl.FileSecurity]::new()
    $keyAcl.SetOwner($owner)
    $keyAcl.SetAccessRuleProtection($true, $false)
    $keyAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($owner, 'FullControl', 'Allow'))
    Set-Acl -LiteralPath $privateKey -AclObject $keyAcl

    $knownHostsOption = 'UserKnownHostsFile="' + $knownHosts.Replace('\', '/') + '"'
    $sshOptions = @('-i', $privateKey, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=yes', '-o', $knownHostsOption, '-o', 'ConnectTimeout=15')
    Invoke-Native -Program $sshExe -ProgramArgs ($sshOptions + @($server,
        "test -f $remoteRoot/shared/.env && sudo -n docker info >/dev/null && docker compose version"))
    if ($VerifyOnly) {
        Write-Host 'SSH authentication, pinned host key and server prerequisites verified. No deployment performed.'
    }
    else {
        # Refuse an existing release so interrupted copies cannot mix with a new build.
        Invoke-Native -Program $sshExe -ProgramArgs ($sshOptions + @($server,
            "test ! -e $remoteRoot/releases/$Version && mkdir -p $remoteRoot/releases"))
        Invoke-Native -Program $scpExe -ProgramArgs ($sshOptions + @('-r', $releaseDir,
            "${server}:./dva-deploy/releases/"))
        Invoke-Native -Program $sshExe -ProgramArgs ($sshOptions + @($server,
            "bash $remoteRoot/releases/$Version/deploy.sh"))
        Write-Host "Verified deployment: $Version"
    }
}
finally {
    # Only these exact, freshly-created temporary paths are removed.
    if (Test-Path -LiteralPath $privateKey) { Remove-Item -LiteralPath $privateKey -Force }
    if (Test-Path -LiteralPath $keyDir) { Remove-Item -LiteralPath $keyDir }
}
