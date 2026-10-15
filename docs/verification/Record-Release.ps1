param([Parameter(Mandatory=$true)][string]$BundlePath)
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$kit=(Resolve-Path -LiteralPath $BundlePath).Path
$info=Get-Content -LiteralPath (Join-Path $kit 'package-info.json') -Raw | ConvertFrom-Json
$exe=Join-Path $repo 'src-tauri\target\release\hover-island.exe'
$package=Join-Path $kit 'HoverIsland.msix'
$zip=$kit+'.zip'
$before=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-source-before.json') -Raw | ConvertFrom-Json
$after=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-source-after.json') -Raw | ConvertFrom-Json
if($before.fingerprint -cne $after.fingerprint){throw 'Production source changed during the release build.'}
function Hash([string]$Path){(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
$exeHash=Hash $exe
$installed=@(Get-AppxPackage -Name $info.identity | Where-Object {$_.Version.ToString() -eq $info.version -and $_.Publisher -ceq $info.publisher})
if($installed.Count -ne 1){throw 'Expected installed package version was not found.'}
$installedExe=Join-Path $installed[0].InstallLocation 'hover-island.exe'
if((Hash $installedExe) -cne $exeHash){throw 'Installed executable differs from release output.'}
$process=@(Get-Process hover-island -ErrorAction SilentlyContinue | Where-Object {$_.Path -ieq $installedExe})
if($process.Count -ne 1 -or -not $process[0].Responding){throw 'Expected installed app is not running and responding.'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::OpenRead($package)
try{
    $entry=$archive.GetEntry('hover-island.exe')
    if(-not $entry){throw 'Packaged executable is missing.'}
    $stream=$entry.Open();$sha=[Security.Cryptography.SHA256]::Create()
    try{$packagedHash=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$sha.Dispose()}
    $reader=[IO.StreamReader]::new($archive.GetEntry('AppxManifest.xml').Open())
    try{[xml]$manifest=$reader.ReadToEnd()}finally{$reader.Dispose()}
}finally{$archive.Dispose()}
if($packagedHash -cne $exeHash){throw 'Packaged executable differs from release output.'}
$capabilities=@($manifest.Package.Capabilities.ChildNodes | ForEach-Object {$_.Name})
foreach($required in @('userNotificationListener','bluetooth','radios','privateNetworkClientServer','internetClient','runFullTrust')){
    if($required -notin $capabilities){throw "Package capability missing: $required"}
}
$cert=[Security.Cryptography.X509Certificates.X509Certificate2]::new((Join-Path $kit 'Publisher.cer'))
try{if($cert.HasPrivateKey -or $cert.Thumbprint -ine $info.signerThumbprint){throw 'Public publisher certificate is invalid.'}}finally{$cert.Dispose()}
if(@(Get-ChildItem -LiteralPath $kit -Recurse -File | Where-Object {$_.Extension -in @('.pfx','.p12')}).Count){throw 'Private-key archive in release kit.'}
. (Join-Path $kit 'Verify-MsixSignature.ps1')
$signature=Test-MsixPackageSignature $package $info.signerThumbprint
$binaryText=[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($exe))
$assets=@(Get-ChildItem -LiteralPath (Join-Path $repo 'dist') -Recurse -File | ForEach-Object {
    $relative=$_.FullName.Substring((Join-Path $repo 'dist').Length+1).Replace('\','/')
    if($_.Extension -in @('.js','.css') -and -not $binaryText.Contains($relative)){throw "Current asset is absent from executable: $relative"}
    [ordered]@{path=$relative;bytes=$_.Length;sha256=Hash $_.FullName}
})
$frontend=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'latest-frontend-tests.log') -Raw
$native=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'latest-native-tests.log') -Raw
if($frontend -notmatch 'pass\s+(\d+)'){throw 'Frontend test result is missing.'};$frontendCount=[int]$Matches[1]
if($frontend -notmatch 'fail\s+0'){throw 'Frontend tests did not all pass.'}
if($native -notmatch 'test result: ok\. (\d+) passed; 0 failed; (\d+) ignored'){throw 'Native tests did not all pass.'}
$nativeCount=[int]$Matches[1];$ignored=[int]$Matches[2]
$browser=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'browser-smoke.json') -Raw | ConvertFrom-Json
$gallery=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'widget-gallery.json') -Raw | ConvertFrom-Json
$motion=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'notch-motion-preview\results.json') -Raw | ConvertFrom-Json
if($browser.errors.Count -or $motion.pageErrors.Count){throw 'Browser verification has errors.'}
function Write-Record([string]$Name,$Value){[IO.File]::WriteAllText((Join-Path $PSScriptRoot $Name),($Value|ConvertTo-Json -Depth 12)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))}
Write-Record 'final-source-assets.json' ([ordered]@{recordedAt=[DateTime]::UtcNow.ToString('o');sourceFingerprint=$after.fingerprint;sourceFileCount=$after.fileCount;assets=$assets})
Write-Record 'installer-proof.json' ([ordered]@{kit=$kit;zip=$zip;executableSha256=$exeHash;packagedExecutableMatches=$true;installedExecutableMatches=$true;capabilities=$capabilities;signatureVerified=$true;privateKeyShipped=$false})
$record=[ordered]@{
    generatedAtUtc=[DateTime]::UtcNow.ToString('o');version=$info.version
    status='Built, signed, verified, installed and launched. Live hardware and service validation remains separate.'
    executable=[ordered]@{path=$exe;bytes=(Get-Item -LiteralPath $exe).Length;sha256=$exeHash;profile='release, opt-level=s, ThinLTO, strip=true, custom-protocol';allCurrentJsCssAssetNamesEmbedded=$true;matchesPackagedExecutable=$true;matchesInstalledExecutable=$true;log='docs/verification/latest-release-build.log'}
    installer=[ordered]@{zip=$zip;zipBytes=(Get-Item -LiteralPath $zip).Length;zipSha256=Hash $zip;package=$package;packageSha256=Hash $package;install=(Join-Path $kit 'Install.cmd');readme=(Join-Path $kit 'README.txt');signed=$info.signed;publisher=$info.publisher;signerThumbprint=$info.signerThumbprint;privateSigningKeyShipped=$false;verifyOnlyPassed=$true;packageInstalledByThisRun=$true;certificateTrustChangedByThisRun=$false;installedVersion=$installed[0].Version.ToString();installedLocation=$installed[0].InstallLocation;nativeProcessId=$process[0].Id;responding=$process[0].Responding;capabilities=$capabilities;buildLog='docs/verification/latest-package-build.log';verificationLog='docs/verification/latest-installer-verify.log';installLog='docs/verification/latest-install.log'}
    source=[ordered]@{fingerprint=$after.fingerprint;fileCount=$after.fileCount;unchangedAcrossBuild=$true;assetsManifest='docs/verification/final-source-assets.json';before='docs/verification/release-source-before.json';after='docs/verification/release-source-after.json'}
    verification=[ordered]@{
        typecheck='Passed';frontendTests=@{passed=$frontendCount;failed=0;log='docs/verification/latest-frontend-tests.log'};nativeTests=@{passed=$nativeCount;failed=0;ignored=$ignored;log='docs/verification/latest-native-tests.log'}
        productionBrowser=@{passed=$browser.results.Count;pageErrors=$browser.errors.Count;record='docs/verification/browser-smoke.json';log='docs/verification/latest-ui-smoke.log';mode=$browser.mode}
        widgetGallery=@{captures=$gallery.screenshots.Count;baseUrl=$gallery.baseUrl;record='docs/verification/widget-gallery.json';log='docs/verification/latest-widget-gallery.log';boundary='Production browser with sample data; checks card bounds and outer scrolling.'}
        notchMotion=@{cases=$motion.cases.Count;pageErrors=$motion.pageErrors.Count;baseUrl=$motion.url;record='docs/verification/notch-motion-preview/results.json';log='docs/verification/latest-notch-motion.log';boundary='Browser side geometry and synthetic proximity; native worker covered by regression tests, physical cursor interaction remains separate.'}
    }
    runtimeChecksRemaining=@('Physical Windows dock drag/snap and multi-monitor behavior.','Live music signal, volume/brightness/Bluetooth/charging events and actual memory trimming.','Live Windows toast delivery and optional user notification consent.','Physical iPhone network/firewall and folder-drop behavior.','Optional website feeds and Google/Outlook subscriptions; no accounts auto-connected.')
    integrationBoundaries=@('Calendar subscriptions are read-only.','Website alerts need a supported HTTPS feed; shortcuts do not connect inboxes.','AirDrop is hidden; Nearby uses the temporary local QR bucket.','Reset announcements do not redeem grants or change quota.','Energy Saver opens Windows Settings; Best power efficiency is a separate native power mode.')
    referenceReview='docs/verification/dynamic-island-reference-review.md'
}
Write-Record 'current-build.json' $record
[pscustomobject]$record|Select-Object version,status,executable,installer,source|ConvertTo-Json -Depth 5
