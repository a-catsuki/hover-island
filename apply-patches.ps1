<#
.SYNOPSIS
  Applies every .patch in patches\incoming (in name order), one commit per patch.

.DESCRIPTION
  For each patch:
    - already applied (reverse check passes)  -> moved to patches\applied, skipped
    - applies cleanly or via 3-way merge       -> committed, moved to patches\applied
    - conflicts                                -> stops, lists the conflicted files
  Needs a clean working tree (commit or stash your own edits first).
  Never pushes.

.EXAMPLE
  .\apply-patches.ps1            # apply everything in patches\incoming
  .\apply-patches.ps1 -DryRun    # only report what would happen
#>
param(
  [string]$Incoming = "patches\incoming",
  [string]$Applied  = "patches\applied",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Git-Quiet { & git @args 2>&1 | Out-Null; return $LASTEXITCODE -eq 0 }

if (-not (Test-Path $Incoming)) { New-Item -ItemType Directory -Force $Incoming | Out-Null }
if (-not (Test-Path $Applied))  { New-Item -ItemType Directory -Force $Applied  | Out-Null }

$patches = Get-ChildItem $Incoming -Filter *.patch | Sort-Object Name
if (-not $patches) { Write-Host "No patches in $Incoming." -ForegroundColor Yellow; exit 0 }

# Ignore the patches folder itself when checking for a clean tree.
$dirty = git status --porcelain -- . ":(exclude)patches" | Where-Object { $_ }
if ($dirty -and -not $DryRun) {
  Write-Host "Working tree has uncommitted changes. Commit or stash them first:" -ForegroundColor Red
  $dirty | ForEach-Object { Write-Host "  $_" }
  exit 1
}

$done = 0; $skipped = 0
foreach ($p in $patches) {
  $path = $p.FullName
  $name = $p.BaseName
  Write-Host "`n== $($p.Name)" -ForegroundColor Cyan

  if (Git-Quiet apply --reverse --check $path) {
    Write-Host "   already applied, skipping" -ForegroundColor DarkGray
    if (-not $DryRun) { Move-Item -Force $path $Applied }
    $skipped++; continue
  }

  $clean = Git-Quiet apply --check $path
  if ($DryRun) {
    if ($clean) { Write-Host "   applies cleanly" -ForegroundColor Green }
    else        { Write-Host "   does not apply cleanly (3-way merge will be tried)" -ForegroundColor Yellow }
    continue
  }

  # git format-patch files carry their own message and author: use git am.
  $isMbox = (Get-Content $path -TotalCount 1) -match '^From [0-9a-f]{40} '
  if ($isMbox) {
    & git am --3way $path
    if ($LASTEXITCODE -ne 0) {
      Write-Host "   CONFLICT. Fix the files, then 'git add' them and run 'git am --continue' (or 'git am --abort')." -ForegroundColor Red
      git diff --name-only --diff-filter=U | ForEach-Object { Write-Host "     $_" }
      exit 1
    }
  } else {
    & git apply --3way --whitespace=nowarn $path
    if ($LASTEXITCODE -ne 0) {
      Write-Host "   CONFLICT in:" -ForegroundColor Red
      git diff --name-only --diff-filter=U | ForEach-Object { Write-Host "     $_" }
      Write-Host "   Resolve the <<<<<<< markers, 'git add' the files, then 'git commit -m `"Apply $name`"'"
      Write-Host "   and move $($p.Name) to $Applied. Or undo with: git reset --hard HEAD"
      exit 1
    }
    & git commit -q -m "Apply $name"
    if ($LASTEXITCODE -ne 0) { Write-Host "   nothing to commit" -ForegroundColor Yellow }
  }

  Move-Item -Force $path $Applied
  Write-Host "   applied and committed" -ForegroundColor Green
  $done++
}

Write-Host "`nDone: $done applied, $skipped already applied." -ForegroundColor Green
if ($done -gt 0) { Write-Host "Rebuild to try it: .\Rebuild.ps1 (or npm run tauri dev)" }
