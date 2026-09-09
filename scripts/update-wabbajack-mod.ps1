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
    # Deliberately NOT a hardcoded mod list. The toolkit is seven mods now, and
    # a list here would be an eighth place to update when one is added or
    # renamed. The archive declares what it contains; this reads it.
    [string[]] $ModIds   = @(),
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
$modsDest = Join-Path $ProjectDir 'Contents\mods'

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
$id = $null
if (Test-Path $wsTxt) {
    $id = Read-Capture $wsTxt '^\s*id\s*=\s*(\d+)'
    if ($id) { Ok "project publishes to Workshop item $id" }
    else     { Say 'WARNING: workshop.txt has no id= line; upload would create a NEW item' }
} else {
    Say 'WARNING: no workshop.txt yet (the zip supplies one)'
}

# What is installed right now, per mod. Reported so the dry run can show each
# one moving rather than a single number that no longer describes the payload.
$before = @{}
if (Test-Path $modsDest) {
    foreach ($d in (Get-ChildItem $modsDest -Directory -ErrorAction SilentlyContinue)) {
        $v = Read-Capture (Join-Path $d.FullName 'common\mod.info') '^\s*modversion\s*=\s*(.+)$'
        if ($v) { $before[$d.Name] = $v }
    }
}
if ($before.Count -eq 0) { Say 'installed: nothing yet' }
else {
    foreach ($k in ($before.Keys | Sort-Object)) { Say ("installed: {0} {1}" -f $k, $before[$k]) }
}

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
$stagedMods = Join-Path $staging 'Contents\mods'
if (-not (Test-Path $stagedMods)) { Die 'archive has no Contents\mods - wrong zip, or wrong layout' }

if ($ModIds.Count -gt 0) {
    $found = $ModIds
} else {
    $found = (Get-ChildItem $stagedMods -Directory | Select-Object -ExpandProperty Name)
}
if ($found.Count -eq 0) { Die 'archive contains no mods' }

# Every mod is checked BEFORE any of them is installed. A partial install of a
# seven-mod set is worse than none: WabbajackCore carries the staff allowlist and
# the settings spine, and the other six declare require=WabbajackCore, so a set
# that lands half-applied is a set where mods silently refuse to load.
$after = @{}
foreach ($m in $found) {
    $mi = Join-Path $stagedMods "$m\common\mod.info"
    if (-not (Test-Path $mi)) { Die "archive is missing $m\common\mod.info - wrong layout" }
    $v = Read-Capture $mi '^\s*modversion\s*=\s*(.+)$'
    if (-not $v) { Die "$m\common\mod.info has no modversion line" }
    $after[$m] = $v
    $req = Read-Capture $mi '^\s*require\s*=\s*(.+)$'
    if ($req) {
        foreach ($r in ($req -split ';')) {
            if ($found -notcontains $r.Trim()) {
                Die "$m requires $($r.Trim()), which is not in this archive"
            }
        }
    }
}
Ok ("archive carries {0} mods: {1}" -f $found.Count, ($found -join ', '))

# The staged workshop.txt is about to overwrite the project's. Preflight read
# the project's id and would have been pointless if this then replaced it with a
# different one: the upload would go to the wrong Workshop item, and the only
# symptom is the server continuing to load the old build.
$stagedId = Read-Capture (Join-Path $staging 'workshop.txt') '^\s*id\s*=\s*(\d+)'
if ($id -and $stagedId -and $id -ne $stagedId) {
    # Parenthesised deliberately: Die "a" + "b" passes three positional
    # arguments rather than concatenating, so the second line was being dropped
    # from the one message in this script you most need to read in full.
    Die ("the archive targets Workshop item $stagedId but this project is $id.`n" +
         "    Installing it would publish to the wrong item. Check the zip.")
}
if ($stagedId) { Ok "archive targets Workshop item $stagedId" }
$luaCount = (Get-ChildItem $stagedMods -Recurse -Filter *.lua).Count
Ok "$luaCount lua files staged"
foreach ($m in ($found | Sort-Object)) {
    $was = if ($before.ContainsKey($m)) { $before[$m] } else { 'not installed' }
    Say ("  {0,-22} {1}  ->  {2}" -f $m, $was, $after[$m])
}

$moved = @($found | Where-Object { $before[$_] -ne $after[$_] })
if ($moved.Count -eq 0) {
    Say 'NOTE: every mod is already at the staged version - Steam may report no change'
}

# Mods the project still has that this archive no longer carries. Without this
# they survive the install and get published again: the uploader ships whatever
# is in Contents\mods, not whatever the archive brought. 1.29.0 removing
# WabbajackSiege is exactly that case -- the folder would have stayed, and the
# Workshop item would have kept serving a mod the build had dropped.
$stale = @($before.Keys | Where-Object { $found -notcontains $_ })
foreach ($m in $stale) { Say ("  {0,-22} {1}  ->  REMOVED" -f $m, $before[$m]) }

if ($DryRun) {
    Step 'Dry run - nothing changed'
    Say ("would install {0} mods into {1}" -f $found.Count, $modsDest)
    if ($stale.Count -gt 0) { Say ("would remove {0}: {1}" -f $stale.Count, ($stale -join ', ')) }
    Remove-Item $staging -Recurse -Force
    exit 0
}

# ----------------------------------------------------------------- install

Step 'Installing'
$modsDir = $modsDest
if (-not (Test-Path $modsDir)) { New-Item -ItemType Directory -Path $modsDir -Force | Out-Null }

# The old folders are moved aside, not deleted. Deleting first contradicts this
# script's whole contract: Remove-Item -Recurse deletes as it walks, so a locked
# file -- the game being open is enough -- aborts partway and leaves NO mod
# folder rather than the one that was working a second ago. They are only
# discarded once the replacements are in place and verified.
#
# ALL of them move aside before ANY of them is copied, and the rollback puts
# every one back. Seven mods that require each other cannot be installed one at
# a time: a failure halfway leaves a set where WabbajackCore is new, three
# feature mods are old, and the ones that declare require=WabbajackCore may not
# load at all. Either the whole set lands or none of it does.
$stamp   = Get-Date -Format yyyyMMdd-HHmmss
$backups = @{}
try {
    foreach ($m in ($found + $stale)) {
        $dest = Join-Path $modsDir $m
        if (Test-Path $dest) {
            $b = "$dest.replaced-$stamp"
            Move-Item $dest $b -Force
            $backups[$m] = $b
        }
    }
    if ($backups.Count -gt 0) { Say ("moved {0} previous mod folders aside" -f $backups.Count) }
} catch {
    foreach ($m in $backups.Keys) {
        Move-Item $backups[$m] (Join-Path $modsDir $m) -Force -ErrorAction SilentlyContinue
    }
    Die "could not move the old mod folders aside (is the game running?): $_"
}

try {
    # Copy each MOD folder to its exact destination rather than copying `Contents`
    # into the project. `Copy-Item <dir> <existing dir> -Recurse` nests the source
    # inside the target, so that form produces Contents\Contents on any project
    # that already had one -- which is every project except a brand new one.
    foreach ($m in $found) {
        Copy-Item (Join-Path $stagedMods $m) $modsDir -Recurse -Force
    }
    foreach ($f in 'workshop.txt', 'preview.png') {
        $src = Join-Path $staging $f
        if (Test-Path $src) { Copy-Item $src $ProjectDir -Force; Say "updated $f" }
    }
} catch {
    # Put everything back exactly as it was before giving up.
    foreach ($m in $backups.Keys) {
        $dest = Join-Path $modsDir $m
        if (Test-Path $dest) { Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue }
        Move-Item $backups[$m] $dest -Force -ErrorAction SilentlyContinue
    }
    Die "install failed and the previous versions were restored: $_"
}
Remove-Item $staging -Recurse -Force

# ------------------------------------------------------------------ verify

Step 'Verifying the installed copy'
$files = 0
foreach ($m in $found) {
    $dest = Join-Path $modsDir $m
    $mi   = Join-Path $dest 'common\mod.info'
    if (-not (Test-Path $mi)) { Die "$m\common\mod.info is missing after install" }
    $installed = Read-Capture $mi '^\s*modversion\s*=\s*(.+)$'
    if ($installed -ne $after[$m]) {
        Die "$m version mismatch after install: expected $($after[$m]), found $installed"
    }
    $n = (Get-ChildItem $dest -Recurse -File).Count
    $files += $n
    Ok ("{0,-22} {1}  ({2} files)" -f $m, $installed, $n)
}
Ok "$files files installed across $($found.Count) mods"

# Only now are the old copies expendable.
foreach ($m in $backups.Keys) {
    Remove-Item $backups[$m] -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`nInstalled $($found.Count) mods" -ForegroundColor Green
Write-Host "Now upload it from the game: Workshop > WabbajackSiege > Update"
Write-Host ""
if ($stale.Count -gt 0) {
    Write-Host "SERVER CONFIG: this build DROPS mods the server may still list." -ForegroundColor Yellow
    Write-Host "Remove these from the server's mod list before it next boots, or it"
    Write-Host "will try to load a mod the Workshop item no longer carries:"
    Write-Host ""
    foreach ($m in ($stale | Sort-Object)) { Write-Host "    $m" -ForegroundColor Yellow }
    Write-Host ""
}
Write-Host "The mods this build ships, all of which need WabbajackCore:" -ForegroundColor Yellow
Write-Host ""
foreach ($m in ($found | Sort-Object)) { Write-Host "    $m" }
Write-Host ""
