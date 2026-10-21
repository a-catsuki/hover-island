# One-shot rebuild: frontend + Rust + MSIX + install. Writes everything to build-log.txt.
# Run from the project folder:  powershell -ExecutionPolicy Bypass -File .\Rebuild.ps1
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
Step 'cargo check' { Push-Location src-tauri; cargo check 2>&1; $code = $LASTEXITCODE; Pop-Location; $global:LASTEXITCODE = $code }
Step 'Tauri release build (compiles Rust)' { npx tauri build --no-bundle }

$exe = Join-Path $PSScriptRoot 'src-tauri\target\release\hover-island.exe'
$age = (Get-Date) - (Get-Item $exe).LastWriteTime
"hover-island.exe was built $([int]$age.TotalMinutes) minutes ago." | Tee-Object -FilePath $log -Append | Write-Host
if ($age.TotalMinutes -gt 30) { "The exe is stale, the Rust build did not produce a new one." | Tee-Object -FilePath $log -Append | Write-Host -ForegroundColor Red; exit 1 }

Step 'Build MSIX' { powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\Build-Msix.ps1 -ExecutablePath $exe -OutputDirectory (Join-Path $PSScriptRoot 'src-tauri\target\msix') -SigningCertificateThumbprint $thumb }

$pkg = Get-ChildItem 'src-tauri\target\msix' -Directory | Where-Object Name -like 'HoverIsland-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
"Installing from $($pkg.FullName)" | Tee-Object -FilePath $log -Append | Write-Host
& (Join-Path $pkg.FullName 'Install.cmd')
"Done $(Get-Date -Format o)" | Tee-Object -FilePath $log -Append | Write-Host
