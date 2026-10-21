[CmdletBinding()]
param(
  [int]$RootProcessId = 0,
  [string]$OutFile
)

$ErrorActionPreference = 'Stop'
# Read-only: do not trim working sets, suspend processes, or force collection.
$processes = @(Get-CimInstance Win32_Process)
if ($RootProcessId -eq 0) {
  $roots = @($processes | Where-Object Name -eq 'hover-island.exe')
  if ($roots.Count -ne 1) {
    throw 'Specify -RootProcessId when there is not exactly one running Hover Island process.'
  }
  $RootProcessId = [int]$roots[0].ProcessId
}
$root = $processes | Where-Object ProcessId -eq $RootProcessId | Select-Object -First 1
if (-not $root -or $root.Name -ne 'hover-island.exe') { throw 'The root must be a running hover-island.exe process.' }
$owned = [System.Collections.Generic.HashSet[int]]::new()
[void]$owned.Add($RootProcessId)
do {
  $previousCount = $owned.Count
  foreach ($process in $processes) {
    if ($owned.Contains([int]$process.ParentProcessId)) { [void]$owned.Add([int]$process.ProcessId) }
  }
} while ($owned.Count -ne $previousCount)

$filter = ($owned | ForEach-Object { "IDProcess=$_" }) -join ' OR '
$counters = @{}
foreach ($counter in @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter $filter)) {
  $counters[[int]$counter.IDProcess] = $counter
}
$rows = @($processes | Where-Object { $owned.Contains([int]$_.ProcessId) } | ForEach-Object {
  $counter = $counters[[int]$_.ProcessId]
  $role = if ($_.ProcessId -eq $RootProcessId) { 'native' }
    elseif ($_.CommandLine -match '--type=([^\s]+)') { $Matches[1] }
    elseif ($_.Name -eq 'msedgewebview2.exe') { 'webview-manager' }
    else { 'helper' }
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    parentPid = [int]$_.ParentProcessId
    name = $_.Name
    role = $role
    privateWorkingSetBytes = if ($counter) { [long]$counter.WorkingSetPrivate } else { $null }
    workingSetBytes = if ($counter) { [long]$counter.WorkingSet } else { $null }
    privateCommitBytes = if ($counter) { [long]$counter.PrivateBytes } else { $null }
  }
})
$missing = @($rows | Where-Object { $null -eq $_.privateWorkingSetBytes }).Count
$operatingSystem = Get-CimInstance Win32_OperatingSystem
$result = [pscustomobject]@{
  capturedAtUtc = [DateTime]::UtcNow.ToString('o')
  rootPid = $RootProcessId
  executable = $root.ExecutablePath
  measurementComplete = $missing -eq 0
  hostFreePhysicalMemoryBytes = [long]$operatingSystem.FreePhysicalMemory * 1024
  hostTotalPhysicalMemoryBytes = [long]$operatingSystem.TotalVisibleMemorySize * 1024
  totalPrivateWorkingSetBytes = if ($missing -eq 0) { [long]($rows | Measure-Object privateWorkingSetBytes -Sum).Sum } else { $null }
  totalPrivateCommitBytes = if ($missing -eq 0) { [long]($rows | Measure-Object privateCommitBytes -Sum).Sum } else { $null }
  basis = 'Owned process tree; private working set is resident RAM excluding shared pages. Private commit is reported separately and is not resident RAM.'
  processes = $rows
}
$json = $result | ConvertTo-Json -Depth 5
if ($OutFile) { [IO.File]::WriteAllText($OutFile, $json, [Text.UTF8Encoding]::new($false)) }
$json
