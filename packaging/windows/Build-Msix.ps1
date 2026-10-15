[CmdletBinding()]
param(
    [string] $ExecutablePath,
    [string] $OutputDirectory,
    [string] $PfxPath,
    [string] $SigningCertificateThumbprint,
    [switch] $CreateLocalSigningCertificate
)

$ErrorActionPreference = 'Stop'

function Resolve-SdkTool([string] $ToolName) {
    $sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    if (-not (Test-Path -LiteralPath $sdkRoot)) {
        throw "Windows SDK bin directory was not found: $sdkRoot"
    }

    $versions = Get-ChildItem -LiteralPath $sdkRoot -Directory |
        Where-Object { $_.Name -match '^10\.0\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending
    foreach ($version in $versions) {
        $candidate = Join-Path $version.FullName "x64\$ToolName.exe"
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw "$ToolName.exe was not found in the Windows SDK."
}

function New-Logo([string] $Source, [string] $Destination, [int] $Edge) {
    $sourceImage = [System.Drawing.Image]::FromFile($Source)
    $bitmap = [System.Drawing.Bitmap]::new($Edge, $Edge, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([System.Drawing.Color]::Transparent)
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $graphics.DrawImage($sourceImage, 0, 0, $Edge, $Edge)
        }
        finally { $graphics.Dispose() }
        $bitmap.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $bitmap.Dispose()
        $sourceImage.Dispose()
    }
}

function Test-CodeSigningCertificate($Certificate) {
    if (-not $Certificate -or -not $Certificate.HasPrivateKey) { return $false }
    $now = [DateTime]::Now
    if ($Certificate.NotBefore -gt $now -or $Certificate.NotAfter -le $now) { return $false }
    $eku = $Certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' } | Select-Object -First 1
    if (-not $eku) { return $false }
    $constraints = $Certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' } | Select-Object -First 1
    if ($constraints -and $constraints.CertificateAuthority) { return $false }
    return ($eku.EnhancedKeyUsages | Where-Object { $_.Value -eq '1.3.6.1.5.5.7.3.3' }).Count -gt 0
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$tauriRoot = Join-Path $repoRoot 'src-tauri'
$tauriConfigPath = Join-Path $tauriRoot 'tauri.conf.json'
$config = Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json

if (-not $ExecutablePath) {
    $releaseExe = Join-Path $tauriRoot 'target\release\hover-island.exe'
    $debugExe = Join-Path $tauriRoot 'target\debug\hover-island.exe'
    if (Test-Path -LiteralPath $releaseExe) { $ExecutablePath = $releaseExe }
    elseif (Test-Path -LiteralPath $debugExe) { $ExecutablePath = $debugExe }
    else { throw 'No compiled hover-island.exe found. Build the app or pass -ExecutablePath.' }
}

$exe = (Resolve-Path -LiteralPath $ExecutablePath).Path
if ([IO.Path]::GetFileName($exe) -ne 'hover-island.exe') {
    throw 'The selected executable must be named hover-island.exe.'
}

if (-not $OutputDirectory) { $OutputDirectory = Join-Path $tauriRoot 'target\msix' }
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) {
    $OutputDirectory = Join-Path $repoRoot $OutputDirectory
}
$null = New-Item -ItemType Directory -Path $OutputDirectory -Force
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path

$versionParts = @($config.version -split '\.')
if ($versionParts.Count -lt 3 -or $versionParts.Count -gt 4 -or
    ($versionParts | Where-Object { $_ -notmatch '^\d+$' })) {
    throw "MSIX requires a numeric 3- or 4-part version; tauri.conf.json has '$($config.version)'."
}
while ($versionParts.Count -lt 4) { $versionParts += '0' }
$packageVersion = $versionParts -join '.'
$stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff')
$unique = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$stage = Join-Path $OutputDirectory "stage-$stamp-$unique"
$packagePath = Join-Path $OutputDirectory "HoverIsland-$packageVersion-x64-$stamp-$unique.msix"
if ((Test-Path -LiteralPath $stage) -or (Test-Path -LiteralPath $packagePath)) {
    throw 'The generated staging or package path already exists; no existing files were changed.'
}

$null = New-Item -ItemType Directory -Path $stage
$assets = Join-Path $stage 'Assets'
$null = New-Item -ItemType Directory -Path $assets
Copy-Item -LiteralPath $exe -Destination (Join-Path $stage 'hover-island.exe')

# Tauri release output can contain runtime DLLs beside the executable. Stage
# those dependencies too, while intentionally excluding PDBs and build files.
$exeDirectory = Split-Path -Parent $exe
Get-ChildItem -LiteralPath $exeDirectory -File -Filter '*.dll' |
    Where-Object { $_.Name -ne 'hover_island_lib.dll' } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $stage $_.Name) }

$icon = Join-Path $tauriRoot 'icons\icon.png'
if (-not (Test-Path -LiteralPath $icon)) { throw "App icon not found: $icon" }
Add-Type -AssemblyName System.Drawing
New-Logo $icon (Join-Path $assets 'Square44x44Logo.png') 44
New-Logo $icon (Join-Path $assets 'Square150x150Logo.png') 150
New-Logo $icon (Join-Path $assets 'StoreLogo.png') 50

$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'AppxManifest.xml') -Raw
$manifest = $manifest.Replace('Version="0.1.0.0"', "Version=`"$packageVersion`"")
$publisher = 'CN=Hover Island, OID.2.25.311729368913984317654407730594956997722=1'
$signingPassword = $null
$certificate = $null
$securePassword = $null
$resolvedPfx = $null
$signMode = 'unsigned'
if (($PfxPath -and $SigningCertificateThumbprint) -or
    ($PfxPath -and $CreateLocalSigningCertificate) -or
    ($SigningCertificateThumbprint -and $CreateLocalSigningCertificate)) {
    throw 'Choose only one signing option: -PfxPath, -SigningCertificateThumbprint, or -CreateLocalSigningCertificate.'
}

if ($PfxPath) {
    $resolvedPfx = (Resolve-Path -LiteralPath $PfxPath).Path
    $securePassword = Read-Host 'PFX password (input is hidden)' -AsSecureString
    $passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try {
        $signingPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
        $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
            $resolvedPfx,
            $signingPassword,
            [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
        )
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr)
    }
    if (-not (Test-CodeSigningCertificate $certificate)) {
        if ($securePassword) { $securePassword.Dispose() }
        if ($certificate) { $certificate.Dispose() }
        throw 'The supplied PFX must contain a currently valid code-signing certificate and private key.'
    }
    $publisher = $certificate.Subject
    $signMode = 'pfx'
}
elseif ($SigningCertificateThumbprint) {
    $thumbprint = $SigningCertificateThumbprint -replace '\s', ''
    $certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$thumbprint" -ErrorAction SilentlyContinue
    if (-not $certificate) { throw "No current-user personal certificate matches thumbprint $thumbprint." }
    if (-not (Test-CodeSigningCertificate $certificate)) {
        throw 'The selected current-user certificate must have a valid code-signing usage and private key.'
    }
    $publisher = $certificate.Subject
    $signMode = 'store'
}
elseif ($CreateLocalSigningCertificate) {
    $publisher = 'CN=Hover Island'
    $certificate = Get-ChildItem Cert:\CurrentUser\My |
        Where-Object { $_.Subject -ceq $publisher -and (Test-CodeSigningCertificate $_) } |
        Sort-Object NotAfter -Descending |
        Select-Object -First 1
    if (-not $certificate) {
        $certificate = New-SelfSignedCertificate `
            -Type Custom `
            -Subject $publisher `
            -CertStoreLocation 'Cert:\CurrentUser\My' `
            -KeyAlgorithm RSA `
            -KeyLength 2048 `
            -HashAlgorithm SHA256 `
            -KeyUsage DigitalSignature `
            -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}') `
            -FriendlyName 'Hover Island MSIX local signing' `
            -NotAfter (Get-Date).AddYears(5)
    }
    if (-not (Test-CodeSigningCertificate $certificate)) {
        throw 'Could not create or reuse a valid current-user Hover Island code-signing certificate.'
    }
    $publisher = $certificate.Subject
    $signMode = 'store'
}
$publisherXml = [Security.SecurityElement]::Escape($publisher)
$manifest = [regex]::Replace($manifest, 'Publisher="[^"]+"', "Publisher=`"$publisherXml`"", 1)
$manifest = $manifest.Replace('Version="0.1.0.0"', "Version=`"$packageVersion`"")
$manifestPath = Join-Path $stage 'AppxManifest.xml'
[IO.File]::WriteAllText($manifestPath, $manifest, [Text.UTF8Encoding]::new($false))

$makeAppx = Resolve-SdkTool 'MakeAppx'
$bundle = Join-Path $OutputDirectory "HoverIsland-$packageVersion-x64-$stamp-$unique"
if (Test-Path -LiteralPath $bundle) { throw 'The generated release bundle path already exists.' }
$null = New-Item -ItemType Directory -Path $bundle
$packagePath = Join-Path $bundle 'HoverIsland.msix'
& $makeAppx pack /v /d $stage /p $packagePath
if ($LASTEXITCODE -ne 0) { throw "MakeAppx failed with exit code $LASTEXITCODE. Staging files were kept at $stage" }

$signed = $false
if ($signMode -ne 'unsigned') {
    $signTool = Resolve-SdkTool 'SignTool'
    if ($signMode -eq 'pfx') {
        # SignTool takes the PFX password as a process argument. It is never
        # echoed or persisted; use the current-user certificate-store mode to
        # avoid passing a password when possible.
        & $signTool sign /fd SHA256 /f $resolvedPfx /p $signingPassword $packagePath
    }
    else {
        & $signTool sign /fd SHA256 /s My /sha1 $certificate.Thumbprint $packagePath
    }
    if ($LASTEXITCODE -ne 0) { throw "SignTool failed with exit code $LASTEXITCODE. The unsigned package is at $packagePath" }
    . (Join-Path $PSScriptRoot 'Verify-MsixSignature.ps1')
    $verified=Test-MsixPackageSignature $packagePath $certificate.Thumbprint
    # A local certificate is deliberately not trusted by this build script.
    # NotTrusted is expected until the user approves the installation publisher.
    $signed = $true
    $cerPath = Join-Path $bundle 'Publisher.cer'
    Export-Certificate -Cert $certificate -FilePath $cerPath -Type CERT | Out-Null
}

$hash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$packagePath.sha256", "$hash  HoverIsland.msix`r`n", [Text.Encoding]::ASCII)
$packageInfo = [ordered]@{
    identity = 'com.hoverisland.app'
    version = $packageVersion
    publisher = $publisher
    signed = $signed
    signerThumbprint = if ($signed) { $certificate.Thumbprint.ToUpperInvariant() } else { $null }
    sha256 = $hash
    package = 'HoverIsland.msix'
}
[IO.File]::WriteAllText((Join-Path $bundle 'package-info.json'), ($packageInfo | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Install.ps1') -Destination (Join-Path $bundle 'Install.ps1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Install.cmd') -Destination (Join-Path $bundle 'Install.cmd')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Trust-Publisher.ps1') -Destination (Join-Path $bundle 'Trust-Publisher.ps1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Verify-MsixSignature.ps1') -Destination (Join-Path $bundle 'Verify-MsixSignature.ps1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'INSTALL-README.txt') -Destination (Join-Path $bundle 'README.txt')

if ($securePassword) { $securePassword.Dispose() }
if ($certificate) { $certificate.Dispose() }
$signingPassword = $null

Write-Output "Package: $packagePath"
Write-Output "Signed: $signed"
if ($signed) { Write-Output "Publisher: $publisher"; Write-Output "Signer thumbprint: $($packageInfo.signerThumbprint)" }
Write-Output "Install flow: $(Join-Path $bundle 'Install.cmd')"
Write-Output "Staging: $stage"
