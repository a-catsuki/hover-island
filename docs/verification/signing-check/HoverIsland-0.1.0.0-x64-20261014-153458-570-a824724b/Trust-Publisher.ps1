[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$CertificatePath,[Parameter(Mandatory=$true)][string]$ExpectedThumbprint)
$ErrorActionPreference='Stop'
if($ExpectedThumbprint -notmatch '^[0-9A-Fa-f]{40}$'){throw 'Invalid publisher thumbprint.'}
$certificate=[Security.Cryptography.X509Certificates.X509Certificate2]::new((Resolve-Path -LiteralPath $CertificatePath).Path)
if($certificate.Thumbprint -ine $ExpectedThumbprint){throw 'The publisher certificate changed.'}
if($certificate.NotBefore -gt [DateTime]::Now -or $certificate.NotAfter -le [DateTime]::Now){throw 'The publisher certificate is not currently valid.'}
$usage=$certificate.Extensions|Where-Object {$_.Oid.Value -eq '2.5.29.37'}|Select-Object -First 1
if(-not $usage -or -not ($usage.EnhancedKeyUsages|Where-Object {$_.Value -eq '1.3.6.1.5.5.7.3.3'})){throw 'This certificate is not restricted to signing code.'}
$constraints=$certificate.Extensions|Where-Object {$_.Oid.Value -eq '2.5.29.19'}|Select-Object -First 1
if($constraints -and $constraints.CertificateAuthority){throw 'A certificate authority cannot be trusted by this installer.'}
# Trust only this signing leaf; never add a root certificate or change security policy.
Import-Certificate -FilePath $CertificatePath -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' -ErrorAction Stop|Out-Null
if(-not(Test-Path -LiteralPath ('Cert:\LocalMachine\TrustedPeople\'+$ExpectedThumbprint))){throw 'Windows did not retain the publisher certificate.'}
