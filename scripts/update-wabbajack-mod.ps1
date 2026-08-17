<#
.SYNOPSIS
    Pulls the current WabbajackSiege build from the Mac and installs it into the
    Zomboid Workshop project on this PC, ready to upload.

.DESCRIPTION
    Replaces the six-step manual round trip: scp, find the project, delete the
    old mod folder, extract, hash-check, notice you extracted a level too high.

    ORDER MATTERS AND IS DELIBERATE. Nothing on disk is touched until the
    download has arrived, verified against the Mac's own checksum, and been
    unpacked to a staging folder that is then checked for the structure the
    uploader expects. A failed or truncated transfer leaves the working copy
    exactly as it was -- which is the opposite of what "delete then extract"
    does when the network drops halfway.

.PARAMETER DryRun
    Do everything except the swap. Prints what would change.

.EXAMPLE
    .\update-wabbajack-mod.ps1
    .\update-wabbajack-mod.ps1 -DryRun
#>

[CmdletBinding()]
param(
    [string] $RemoteHost = 'dev@192.168.50.131',
    [string] $RemoteZip  = '/Users/dev/Desktop/WabbajackSiege-project.zip',
    [string] $ProjectDir = "$env:USERPROFILE\Zomboid\Workshop\WabbajackSiege",
    [string] $WorkDir    = 'D:\downloads',
    [string] $ModId      = 'WabbajackSiege',
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

function Say  { param($m) Write-Host "  $m" }
function Step { param($m) Write-Host "`n$m" -ForegroundColor Cyan }
function Ok   { param($m) Write-Host "  OK  $m" -ForegroundColor Green }
function Die  { param($m) Write-Host "`nFAILED: $m" -ForegroundColor Red; exit 1 }

# Select-String returns nothing when a pattern misses, and reaching through
# .Matches.Groups on that throws a null-index error rather than saying which
# file disappointed it. Every read of a config value goes through here.
function Read-Capture {
    param([string] $Path, [string] $Pattern)
    if (-not (Test-Path $Path)) { return $null }
    $m = Select-String -Path $Path -Pattern $Pattern -ErrorAction SilentlyContinue |
         Select-Object -First 1
    if (-not $m -or $m.Matches.Count -eq 0) { return $null }
    return $m.Matches[0].Groups[1].Value.Trim()
}

$zipLocal = Join-Path $WorkDir 'WabbajackSiege-project.zip'
$staging  = Join-Path $WorkDir '.wabbajack-staging'
$modPath  = Join-Path $ProjectDir "Contents\mods\$ModId"

# --------------------------------------------------------------- preflight

Step 'Checking prerequisites'
foreach ($exe in 'ssh', 'scp') {
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) {
        Die "$exe not found. Install the Windows OpenSSH client (Settings > Apps > Optional Features)."
    }
}
if (-not (Test-Path $WorkDir)) { Die "Work directory $WorkDir does not exist." }
Ok "ssh/scp present, $WorkDir writable"

# The project must already exist. Creating it here would produce a project with
# no workshop.txt id, and uploading THAT publishes a brand new Workshop item
# instead of updating the existing one.
if (-not (Test-Path $ProjectDir)) {
    Die "Project $ProjectDir not found. Create it in-game first, or fix -ProjectDir."
}
$wsTxt = Join-Path $ProjectDir 'workshop.txt'
if (Test-Path $wsTxt) {
    $id = Read-Capture $wsTxt '^\s*id\s*=\s*(\d+)'
    if ($id) { Ok "project publishes to Workshop item $id" }
    else     { Say 'WARNING: workshop.txt has no id= line; upload would create a NEW item' }
} else {
    Say 'WARNING: no workshop.txt yet (the zip supplies one)'
}

$before = 'none'
$modInfo = Join-Path $modPath 'common\mod.info'
$v = Read-Capture $modInfo '^\s*modversion\s*=\s*(.+)$'
if ($v) { $before = $v }
Say "installed version: $before"

# ---------------------------------------------------------------- download

Step 'Downloading from the Mac'
if (Test-Path $zipLocal) { Remove-Item $zipLocal -Force }
& scp -q "${RemoteHost}:${RemoteZip}" $zipLocal
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $zipLocal)) {
    Die "scp failed. Is the Mac awake and Remote Login on? Try: ssh $RemoteHost"
}
Ok ('downloaded {0:N0} bytes' -f (Get-Item $zipLocal).Length)

# End-to-end integrity: the Mac hashes the file it holds, we hash what arrived.
# Catches a truncated transfer, which otherwise unpacks "successfully" and
# installs a half a mod.
Step 'Verifying against the source checksum'
$remoteRaw  = (& ssh $RemoteHost "shasum -a 256 '$RemoteZip'" 2>$null) | Select-Object -First 1
$remoteHash = if ($remoteRaw) { ($remoteRaw -split '\s+')[0].ToLower() } else { $null }
$localHash  = (Get-FileHash -Algorithm SHA256 $zipLocal).Hash.ToLower()
if (-not $remoteHash) { Say 'WARNING: could not read remote checksum, continuing on local validity only' }
elseif ($remoteHash -ne $localHash) { Die "checksum mismatch`n    mac: $remoteHash`n    pc : $localHash" }
else { Ok "sha256 matches ($($localHash.Substring(0,16))...)" }

# ----------------------------------------------------------------- staging

Step 'Unpacking to staging'
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
try { Expand-Archive -Path $zipLocal -DestinationPath $staging -Force }
catch { Die "the archive would not expand: $_" }

# Validate the shape BEFORE anything is destroyed. The classic failure is
# extracting a level too high, which leaves the uploader reading the old files
# and reporting "no change".
$need = @(
    "Contents\mods\$ModId\common\mod.info",
    "Contents\mods\$ModId\common\media\lua\server"
)
foreach ($rel in $need) {
    if (-not (Test-Path (Join-Path $staging $rel))) { Die "archive is missing $rel - wrong zip, or wrong layout" }
}
$after = Read-Capture (Join-Path $staging "Contents\mods\$ModId\common\mod.info") '^\s*modversion\s*=\s*(.+)$'
if (-not $after) { Die 'staged mod.info has no modversion line' }
$luaCount = (Get-ChildItem (Join-Path $staging "Contents\mods\$ModId") -Recurse -Filter *.lua).Count
Ok "staged version $after, $luaCount lua files"

if ($before -eq $after) { Say "NOTE: same version as installed ($after) - Steam may report no change" }

if ($DryRun) {
    Step 'Dry run - nothing changed'
    Say "would install $before -> $after into $modPath"
    Remove-Item $staging -Recurse -Force
    exit 0
}

# ----------------------------------------------------------------- install

Step 'Installing'
# Delete rather than overwrite: a file removed upstream would otherwise survive
# here and ship inside the next upload.
if (Test-Path $modPath) {
    Remove-Item $modPath -Recurse -Force
    Say 'removed the previous mod folder'
}
# Copy the MOD folder to its exact destination rather than copying `Contents`
# into the project. `Copy-Item <dir> <existing dir> -Recurse` nests the source
# inside the target, so that form produces Contents\Contents on any project that
# already had one -- which is every project except a brand new one.
$modsDir = Join-Path $ProjectDir 'Contents\mods'
if (-not (Test-Path $modsDir)) { New-Item -ItemType Directory -Path $modsDir -Force | Out-Null }
Copy-Item (Join-Path $staging "Contents\mods\$ModId") $modsDir -Recurse -Force
foreach ($f in 'workshop.txt', 'preview.png') {
    $src = Join-Path $staging $f
    if (Test-Path $src) { Copy-Item $src $ProjectDir -Force; Say "updated $f" }
}
Remove-Item $staging -Recurse -Force

# ------------------------------------------------------------------ verify

Step 'Verifying the installed copy'
if (-not (Test-Path $modInfo)) { Die 'mod.info is missing after install' }
$installed = Read-Capture $modInfo '^\s*modversion\s*=\s*(.+)$' 
if ($installed -ne $after) { Die "version mismatch after install: expected $after, found $installed" }
Get-ChildItem $modPath -Recurse -File | ForEach-Object {
    '{0}  {1}' -f (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.Substring(0, 16).ToLower(),
                  $_.FullName.Substring($modPath.Length + 1)
} | ForEach-Object { Say $_ }

Write-Host "`nInstalled $before -> $after" -ForegroundColor Green
Write-Host "Now upload it from the game: Workshop > $ModId > Update`n"
