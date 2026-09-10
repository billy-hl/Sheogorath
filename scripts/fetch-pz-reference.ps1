<#
.SYNOPSIS
    Pushes a handful of READ-ONLY Project Zomboid reference files from this PC
    up to the Mac, so the mod's custom item can be checked against what the game
    actually ships.

.DESCRIPTION
    THIS RUNS ON THE PC AND PUSHES. Everything else in this repo pulls Mac->PC:
    update-wabbajack-mod.bat fetches the .ps1, and that .ps1 fetches the build
    zip. Nothing has ever gone the other way, which is why the existing launcher
    cannot do this job - it is not a missing flag, it is the opposite direction.

    The Mac cannot reach in and take these itself. It has no SSH server to talk
    to on this side: the PC has the OpenSSH *client*, which is what lets it scp
    FROM the Mac, and a client does not accept incoming connections. So the PC
    has to be the one to push.

    Nothing here is copied into the mod or redistributed. These are inputs for
    reading conventions off - scale, axis, animation names - and the reason they
    are needed is that the katar's mesh, its stat baselines and its swing
    animation were all authored on a Mac with no copy of the game on it.

.PARAMETER GameDir
    The Zomboid install. Found automatically from the Steam library list if you
    do not pass one.
#>

[CmdletBinding()]
param(
    [string] $RemoteHost = 'dev@192.168.50.131',
    [string] $RemoteDir  = '/Users/dev/Desktop/pz-reference',
    [string] $GameDir    = ''
)

$ErrorActionPreference = 'Stop'
function Say  ($m) { Write-Host "  $m" }
function Ok   ($m) { Write-Host "  OK  $m" -ForegroundColor Green }
function Die  ($m) { Write-Host "`n  FAILED: $m`n" -ForegroundColor Red; exit 1 }

Write-Host "`n  Project Zomboid reference fetch"
Write-Host   "  -------------------------------"

# ------------------------------------------------------------- find the game
#
# NOTE ON Join-Path: it validates the drive qualifier, so Join-Path 'E:\Steam'
# on a machine with no E: drive THROWS rather than returning a path that simply
# is not there. Under ErrorActionPreference Stop that killed the whole script
# on the first probe of a drive letter that did not exist. Candidate paths are
# therefore assembled by hand below - a path that does not exist is a normal
# answer while probing, not an error.
function Combine([string] $a, [string] $b) {
    return ($a.TrimEnd('\') + '\' + $b)
}
function Exists([string] $p) {
    try { return (Test-Path -LiteralPath $p -ErrorAction SilentlyContinue) }
    catch { return $false }
}

if (-not $GameDir) {
    $roots = New-Object System.Collections.Generic.List[string]

    # The registry knows where Steam is; guessing drive letters is the fallback,
    # not the plan.
    foreach ($key in 'HKCU:\Software\Valve\Steam', 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam') {
        try {
            $sp = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).SteamPath
            if ($sp) { $roots.Add(($sp -replace '/', '\')) }
        } catch { }
    }
    foreach ($guess in "${env:ProgramFiles(x86)}\Steam", "$env:ProgramFiles\Steam",
                       'C:\Steam', 'D:\Steam', 'E:\Steam', 'D:\SteamLibrary', 'E:\SteamLibrary') {
        if ($guess) { $roots.Add($guess) }
    }

    # Every library folder Steam itself lists, which is how a game on another
    # drive gets found without guessing that drive's letter.
    foreach ($r in @($roots)) {
        $vdf = Combine $r 'steamapps\libraryfolders.vdf'
        if (Exists $vdf) {
            try {
                foreach ($m in ([regex]'"path"\s+"(.+?)"').Matches((Get-Content -Raw $vdf))) {
                    $roots.Add(($m.Groups[1].Value -replace '\\\\', '\'))
                }
            } catch { }
        }
    }

    foreach ($r in ($roots | Where-Object { $_ } | Select-Object -Unique)) {
        $candidate = Combine $r 'steamapps\common\ProjectZomboid'
        if (Exists (Combine $candidate 'media')) { $GameDir = $candidate; break }
    }
}
if (-not $GameDir -or -not (Exists (Combine $GameDir 'media'))) {
    Die ("could not find the Zomboid install. Pass it:`n" +
         "    fetch-pz-reference.bat -GameDir ""D:\Steam\steamapps\common\ProjectZomboid""`n`n" +
         "    In Steam: right-click Project Zomboid > Manage > Browse local files,`n" +
         "    and copy the folder from the address bar.")
}
Ok "game at $GameDir"

$media = Join-Path $GameDir 'media'
$stage = Join-Path $env:TEMP 'pz-reference'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# ------------------------------------------------------------------ gather
# Listings rather than whole directories where a name list is the answer: "is
# there a punch animation" does not need the animation.
#
# NOTE: B42 moved the item scripts. scripts\Items_Weapons.txt was a B41 path and
# came back "not here" on the first run, so weapon scripts are now found by
# searching rather than by a hardcoded name.

$exact = @(
    @{ From = 'models_X\weapons\1handed\HuntingKnife.x';  As = 'HuntingKnife.x' },
    @{ From = 'models_X\weapons\2handed\Shovel.x';        As = 'Shovel.x' },
    @{ From = 'lua\server\Items\ProceduralDistributions.lua'; As = 'ProceduralDistributions.lua' },
    @{ From = 'lua\server\Items\Distributions.lua';           As = 'Distributions.lua' }
)
foreach ($w in $exact) {
    $src = Join-Path $media $w.From
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $stage $w.As) -Force
        Ok ("{0}  ({1:N0} bytes)" -f $w.As, (Get-Item $src).Length)
    } else {
        Say "not here, skipping: $($w.From)"
    }
}

# Weapon and animation-facing scripts, wherever B42 decided to put them. The
# relative path is folded into the filename so two files called the same thing
# in different folders cannot overwrite each other on the way into one staging
# directory.
$patterns = @('*eapon*.txt', '*nife*.txt', '*hovel*.txt')
$scriptsDir = Join-Path $media 'scripts'
if (Test-Path $scriptsDir) {
    $hits = @()
    foreach ($pat in $patterns) {
        $hits += Get-ChildItem $scriptsDir -Recurse -File -Filter $pat -ErrorAction SilentlyContinue
    }
    foreach ($f in ($hits | Sort-Object FullName -Unique)) {
        $rel = $f.FullName.Substring($scriptsDir.Length + 1) -replace '[\\]', '_'
        Copy-Item $f.FullName (Join-Path $stage "script_$rel") -Force
        Ok ("script_{0}  ({1:N0} bytes)" -f $rel, $f.Length)
    }
    if ($hits.Count -eq 0) { Say "no weapon scripts matched under $scriptsDir" }
}

# The animation set definitions are what actually map a SwingAnim token onto an
# animation, so these decide whether the katar can be given a punch.
foreach ($d in 'AnimSets') {
    $src = Join-Path $media $d
    if (Test-Path $src) {
        foreach ($f in (Get-ChildItem $src -Recurse -File -ErrorAction SilentlyContinue)) {
            $rel = $f.FullName.Substring($src.Length + 1) -replace '[\\]', '_'
            Copy-Item $f.FullName (Join-Path $stage "animset_$rel") -Force
        }
        Ok ("$d  ({0} files)" -f (Get-ChildItem $src -Recurse -File).Count)
    } else {
        Say "not here, skipping: $d"
    }
}

foreach ($d in 'anims_X', 'models_X\weapons', 'scripts') {
    $src = Join-Path $media $d
    if (Test-Path $src) {
        $name = ($d -replace '[\\]', '_') + '.listing.txt'
        Get-ChildItem $src -Recurse -File |
            ForEach-Object { $_.FullName.Substring($media.Length + 1) } |
            Sort-Object | Set-Content (Join-Path $stage $name)
        Ok ("{0}  ({1} entries)" -f $name, (Get-Content (Join-Path $stage $name)).Count)
    } else {
        Say "not here, skipping: $d"
    }
}

$files = Get-ChildItem $stage -File
if ($files.Count -eq 0) { Die "nothing was gathered - is $media the right folder?" }

# -------------------------------------------------------------------- push
#
# ONE ARCHIVE, NOT N FILES. The first version passed a wildcard, which neither
# PowerShell nor Windows scp expands, so scp got a literal asterisk. Expanding
# the list here fixed that and immediately hit the real ceiling: AnimSets alone
# is ~2950 files, and every path concatenated onto one command line runs past
# the Windows limit - "The filename or extension is too long", which is what
# that error actually means. Compressing first makes it one argument no matter
# how many files were gathered, and it is faster over the wire besides.

$zip = Join-Path $env:TEMP 'pz-reference.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }

Write-Host "`n  Compressing $($files.Count) files"
try {
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
} catch {
    Die "could not compress the staging folder: $_"
}
Ok ("pz-reference.zip  ({0:N0} bytes)" -f (Get-Item $zip).Length)

Write-Host "`n  Pushing to ${RemoteHost}:$RemoteDir"
& ssh $RemoteHost "mkdir -p '$RemoteDir'"
if ($LASTEXITCODE -ne 0) {
    Die ("could not reach $RemoteHost.`n" +
         "    Unlike a missing file, this one really is the connection: is the`n" +
         "    Mac awake with Remote Login on? Try:  ssh $RemoteHost")
}
& scp -q $zip "${RemoteHost}:$RemoteDir/"
if ($LASTEXITCODE -ne 0) { Die "scp failed on the way up." }

Ok "sent"
Remove-Item $stage -Recurse -Force
Remove-Item $zip -Force
Write-Host "`n  Done. pz-reference.zip is on the Mac at $RemoteDir"
Write-Host   "  Nothing else to do here - this script is only needed when fresh"
Write-Host   "  reference data is wanted off a new game build.`n"
