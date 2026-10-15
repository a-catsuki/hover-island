[CmdletBinding()]
param([switch]$VerifyOnly)

$ErrorActionPreference = 'Stop'

function Fail([string] $Message) {
    Write-Error $Message
    exit 1
}

$root = $PSScriptRoot
$packagePath = Join-Path $root 'HoverIsland.msix'
$infoPath = Join-Path $root 'package-info.json'
$hashPath = "$packagePath.sha256"
$certificatePath = Join-Path $root 'Publisher.cer'

foreach ($path in @($packagePath, $infoPath, $hashPath, $certificatePath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Fail "Required installer file is missing: $path" }
}

$info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
if (-not $info.signed -or -not $info.signerThumbprint) {
    Fail 'This package is unsigned. Rebuild it with a signing certificate before installing.'
}

$expectedHashLine = Get-Content -LiteralPath $hashPath -TotalCount 1
if ($expectedHashLine -notmatch '^(?<Hash>[0-9a-fA-F]{64})\s+HoverIsland\.msix$') {
    Fail 'The package SHA-256 sidecar is malformed.'
}
$actualHash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash
if ($actualHash -ine $Matches.Hash -or $actualHash -ine $info.sha256) {
    Fail 'The MSIX file hash does not match its build manifest.'
}

$certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($certificatePath)
if ($certificate.Thumbprint -ine $info.signerThumbprint) {
    Fail 'Publisher.cer does not match the signer thumbprint recorded for this package.'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($packagePath)
try {
    $manifestEntry = $archive.GetEntry('AppxManifest.xml')
    if (-not $manifestEntry) { Fail 'The MSIX package has no AppxManifest.xml.' }
    $reader = [IO.StreamReader]::new($manifestEntry.Open())
    try { [xml] $manifest = $reader.ReadToEnd() }
    finally { $reader.Dispose() }
}
finally { $archive.Dispose() }

$identity = $manifest.Package.Identity
if ($identity.Name -cne $info.identity -or $identity.Version -cne $info.version) {
    Fail 'The package identity or version does not match package-info.json.'
}
if ($identity.Publisher -cne $info.publisher -or $identity.Publisher -cne $certificate.Subject) {
    Fail 'The manifest publisher does not match the supplied public certificate.'
}

. (Join-Path $root 'Verify-MsixSignature.ps1')
$verified=Test-MsixPackageSignature $packagePath $certificate.Thumbprint

Write-Host "Package signature and hash verified for $($identity.Name) $($identity.Version)."
Write-Host "Publisher: $($certificate.Subject)"
Write-Host "Signer thumbprint: $($certificate.Thumbprint)"
if($VerifyOnly){Write-Host 'Verification only: no package or certificate was installed.';exit 0}
$peerTrustPath='Cert:\LocalMachine\TrustedPeople\'+$certificate.Thumbprint
if (-not $verified.Trusted -and -not(Test-Path -LiteralPath $peerTrustPath)) {
    Write-Host ''
    Write-Host 'This personal build uses a local signing certificate, rather than a Microsoft Store publisher.'
    Write-Host 'Windows needs your approval to trust this publisher before installing it. Only this code-signing certificate is added to Trusted People; no root certificate is installed.'
    $answer=Read-Host 'Trust this publisher and install Hover Island? [y/N]'
    if($answer -notmatch '^(y|yes)$'){Write-Host 'Installation cancelled. Nothing was installed or trusted.';exit 0}
    $helper=Join-Path $root 'Trust-Publisher.ps1'
    if(-not(Test-Path -LiteralPath $helper -PathType Leaf)){Fail 'Publisher trust helper is missing.'}
    $arguments=@('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$helper+'"'),'-CertificatePath',('"'+$certificatePath+'"'),'-ExpectedThumbprint',$certificate.Thumbprint)
    try{$approval=Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru}catch{Fail 'Windows publisher approval was cancelled.'}
    if($approval.ExitCode -ne 0){Fail 'Windows could not approve this publisher. No app was installed.'}
    $verified=Test-MsixPackageSignature $packagePath $certificate.Thumbprint
    if(-not $verified.Trusted -and -not(Test-Path -LiteralPath $peerTrustPath)){Fail 'Windows did not retain the approved publisher. No app was installed.'}
}

try {
    Add-AppxPackage -Path $packagePath -ErrorAction Stop
}
catch {
    Write-Error "Windows did not install the package: $($_.Exception.Message)"
    Write-Host 'Windows may provide an Activity ID above for installation diagnostics. Existing Hover Island notes and settings are not removed.'
    exit 1
}

$installed = Get-AppxPackage -Name $info.identity | Where-Object { $_.Version.ToString() -eq $info.version -and $_.Publisher -ceq $info.publisher }
if (-not $installed) { Fail 'Windows accepted the install command but the expected package version was not found.' }
# Preserve standalone data when MSIX gives the app a redirected Roaming folder.
# Copy only into a new destination; never replace a packaged app's existing data.
$legacyData=Join-Path $env:APPDATA 'com.hoverisland.app'
$packagedData=Join-Path $env:LOCALAPPDATA ('Packages\'+$installed[0].PackageFamilyName+'\LocalCache\Roaming\com.hoverisland.app')
if((Test-Path -LiteralPath $legacyData -PathType Container) -and -not(Test-Path -LiteralPath $packagedData)){
    try{New-Item -ItemType Directory -Path $packagedData -Force|Out-Null;Get-ChildItem -LiteralPath $legacyData|ForEach-Object{Copy-Item -LiteralPath $_.FullName -Destination $packagedData -Recurse -ErrorAction Stop};Write-Host 'Existing standalone notes and settings were copied into the new package.'}catch{Write-Warning 'The package installed, but some existing data could not be copied. Your original files remain intact.'}
}
Write-Host 'Hover Island is installed for the current user.'
Write-Host 'Notification access still requires the in-app Windows permission prompt. Bluetooth and radio APIs are declared by this MSIX manifest.'
Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\'+$installed[0].PackageFamilyName+'!HoverIsland') -WindowStyle Hidden
Write-Host 'In Hover Island, open Settings > Notifications > Allow Windows alerts, then choose Allow in Windows. Choose your desktop apps in Connections.'
