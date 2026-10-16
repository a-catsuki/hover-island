# Packaged notification diagnostics

Run the installed Hover Island executable from a terminal with `--notification-diagnostics`. This read-only mode exits before the Tauri window or app state starts. It writes one JSON object to stdout and creates no files:

```json
{"packaged":true,"access":"allowed","toastCount":3}
```

The output includes only package identity, Windows notification-listener access, and the number of current toast notifications. It does not read or print titles, bodies, app names, or notification IDs. It never requests permission and does not emit a synthetic test notification.

Exit codes: `0` means access was allowed and the count was read; `2` means access was denied; `3` means the process is unpackaged or access has not yet been granted; `4` means Windows package identity could not be checked; `5` means Windows could not provide listener status or the toast count. A null `toastCount` means the count was intentionally unavailable for that status.

Capture stdout explicitly for the Windows GUI executable (PowerShell 7):

```powershell
$exe = Join-Path (Get-AppxPackage com.hoverisland.app).InstallLocation 'hover-island.exe'
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $exe
$start.ArgumentList.Add('--notification-diagnostics')
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$process = [Diagnostics.Process]::Start($start)
$json = $process.StandardOutput.ReadToEnd()
$process.WaitForExit()
$json
$process.ExitCode
```

Run this against the installed executable. Running the release output outside its package should report `unpackaged`; it cannot prove notification delivery.
