# One-shot rebuild: frontend + Rust + MSIX + install. Writes everything to build-log.txt.
# Run from the project folder:  powershell -ExecutionPolicy Bypass -File .\Rebuild.ps1
param(
    # Quick local build: 16 codegen units, no LTO, incremental, separate target folder.
    # Several times faster than a ship build. Use the default (no switch) for builds you publish.
    [switch] $Fast,
    # Also run `cargo check` first. Off by default: the build below reports the same errors.
    [switch] $Check
)
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
$log = Join-Path $PSScriptRoot 'build-log.txt'
"Rebuild started $(Get-Date -Format o)" | Set-Content $log
$thumb = 'B695B47BAE4B74B294B3E9C184F2C0A8394C9AF6'

function Step([string] $Name, [scriptblock] $Body) {
    "`n=== $Name ===" | Tee-Object -FilePath $log -Append | Write-Host
    & $Body 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $log -Append | Write-Host
    if ($LASTEXITCODE -ne 0) {
        "`nFAILED at step: $Name (exit $LASTEXITCODE). Send build-log.txt to Claude." | Tee-Object -FilePath $log -Append | Write-Host -ForegroundColor Red
        exit 1
    }
}

Step 'Stop running app' { Get-Process hover-island -ErrorAction SilentlyContinue | Stop-Process -Force; $global:LASTEXITCODE = 0 }
Step 'npm install' { npm install --no-audit --no-fund }
Step 'Typecheck' { npm run typecheck }
Step 'Frontend build' { npm run build }
if ($Fast) {
    $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = '16'
    $env:CARGO_PROFILE_RELEASE_LTO = 'false'
    $env:CARGO_PROFILE_RELEASE_INCREMENTAL = 'true'
    $env:CARGO_TARGET_DIR = Join-Path $PSScriptRoot 'src-tauri\target-fast'
    "FAST build: no LTO, incremental, target-fast folder." | Tee-Object -FilePath $log -Append | Write-Host
}
$targetRoot = if ($Fast) { Join-Path $PSScriptRoot 'src-tauri\target-fast' } else { Join-Path $PSScriptRoot 'src-tauri\target' }
if ($Check) { Step 'cargo check' { Push-Location src-tauri; cargo check 2>&1; $code = $LASTEXITCODE; Pop-Location; $global:LASTEXITCODE = $code } }
Step 'Tauri release build (compiles Rust)' { npx tauri build --no-bundle }

$exe = Join-Path $targetRoot 'release\hover-island.exe'
$age = (Get-Date) - (Get-Item $exe).LastWriteTime
"hover-island.exe was built $([int]$age.TotalMinutes) minutes ago." | Tee-Object -FilePath $log -Append | Write-Host
if ($age.TotalMinutes -gt 30) { "The exe is stale, the Rust build did not produce a new one." | Tee-Object -FilePath $log -Append | Write-Host -ForegroundColor Red; exit 1 }

Step 'Build MSIX' { powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\Build-Msix.ps1 -ExecutablePath $exe -OutputDirectory (Join-Path $PSScriptRoot 'src-tauri\target\msix') -SigningCertificateThumbprint $thumb }

$pkg = Get-ChildItem 'src-tauri\target\msix' -Directory | Where-Object Name -like 'HoverIsland-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
"Installing from $($pkg.FullName)" | Tee-Object -FilePath $log -Append | Write-Host
& (Join-Path $pkg.FullName 'Install.cmd')
# Start the freshly installed package (not an old exe from a shortcut), so what you see is this build.
Get-Process hover-island -ErrorAction SilentlyContinue | Where-Object { $_.Path -notlike '*WindowsApps*' } | Stop-Process -Force
$installed = Get-AppxPackage com.hoverisland.app | Sort-Object Version -Descending | Select-Object -First 1
if ($installed) {
    "Installed package version $($installed.Version)" | Tee-Object -FilePath $log -Append | Write-Host -ForegroundColor Green
    if (-not (Get-Process hover-island -ErrorAction SilentlyContinue)) { Start-Process "shell:AppsFolder\$($installed.PackageFamilyName)!HoverIsland" }
} else {
    "The package did not install. Send build-log.txt to Claude." | Tee-Object -FilePath $log -Append | Write-Host -ForegroundColor Red
}
"Done $(Get-Date -Format o)" | Tee-Object -FilePath $log -Append | Write-Host
