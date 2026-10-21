# Publishes the newest built MSIX as an in-app update.
#   1. bump "version" in src-tauri/tauri.conf.json and src-tauri/Cargo.toml (3 parts, e.g. 0.1.6)
#   2. run Rebuild.ps1 (builds, packages and installs it)
#   3. run this:  powershell -ExecutionPolicy Bypass -File packaging\windows\Publish-Update.ps1 -Notes "What changed"
#   4. deploy the site (cd marketing; vercel deploy --prod). Installed apps pick it up under Settings > About.
[CmdletBinding()]
param([string] $Notes = '')
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$config = Get-Content (Join-Path $repo 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$version = [string]$config.version
$bundle = Get-ChildItem (Join-Path $repo 'src-tauri\target\msix') -Directory | Where-Object Name -like 'HoverIsland-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $bundle) { throw 'No built package found. Run Rebuild.ps1 first.' }
$info = Get-Content (Join-Path $bundle.FullName 'package-info.json') -Raw | ConvertFrom-Json
if (-not $info.signed) { throw 'The newest package is unsigned.' }
if (-not ([string]$info.version).StartsWith("$version.")) { throw "The newest package is $($info.version), but tauri.conf.json says $version. Rebuild first." }
$updates = Join-Path $repo 'marketing\updates'
New-Item -ItemType Directory -Path $updates -Force | Out-Null
$name = "HoverIsland-$version.msix"
Copy-Item (Join-Path $bundle.FullName 'HoverIsland.msix') (Join-Path $updates $name) -Force
Copy-Item (Join-Path $bundle.FullName 'Publisher.cer') (Join-Path $updates 'Publisher.cer') -Force
$hash = (Get-FileHash (Join-Path $updates $name) -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = [ordered]@{
    version = $version
    url = "https://hover-island.vercel.app/updates/$name"
    sha256 = $hash
    notes = $Notes
    published = (Get-Date).ToUniversalTime().ToString('o')
}
[IO.File]::WriteAllText((Join-Path $updates 'latest.json'), ($manifest | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Host "Published $name ($hash). Now deploy the site: cd marketing; vercel deploy --prod"
