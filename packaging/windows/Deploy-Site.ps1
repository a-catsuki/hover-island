# Deploys marketing/ to Vercel production, including the update package.
#   powershell -ExecutionPolicy Bypass -File packaging\windows\Deploy-Site.ps1
# The repo's .gitignore excludes *.msix and *.cer, and the Vercel CLI honours it, so deploying
# from inside the repo silently drops updates/HoverIsland-*.msix and Publisher.cer (the 404 behind
# "update available" with a failed download). This copies the site outside the repo first.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$site = Join-Path $repo 'marketing'
$stage = Join-Path ([IO.Path]::GetTempPath()) "hover-island-site-$([guid]::NewGuid().ToString('N'))"
Copy-Item $site $stage -Recurse
try {
    $manifest = Get-Content (Join-Path $stage 'updates\latest.json') -Raw | ConvertFrom-Json
    $package = Join-Path $stage "updates\HoverIsland-$($manifest.version).msix"
    if (-not (Test-Path $package)) { throw "latest.json names $($manifest.version) but $package is missing. Run Publish-Update.ps1." }
    $hash = (Get-FileHash $package -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $manifest.sha256) { throw "SHA-256 of $package does not match latest.json." }
    Push-Location $stage
    try {
        npx --yes vercel@latest deploy --prod --yes
        if ($LASTEXITCODE -ne 0) { throw "vercel deploy failed (exit $LASTEXITCODE)." }
    } finally { Pop-Location }
} finally {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
$live = Invoke-WebRequest "https://hover-island.vercel.app/updates/HoverIsland-$($manifest.version).msix" -Method Head -UseBasicParsing
"Live package: HTTP $($live.StatusCode)"
