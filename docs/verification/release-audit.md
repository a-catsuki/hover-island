# Windows release packaging audit

**Scope:** Read-only review of `packaging/windows/Build-Msix.ps1`, `Install.ps1`, `Trust-Publisher.ps1`, `Verify-MsixSignature.ps1`, and `AppxManifest.xml`, checked against Tauri config and app data paths. No package build, install, certificate creation, trust import, or certificate-store mutation was performed.

## Certificate-policy result: aligned

The previous mismatch is resolved. `Build-Msix.ps1` now requires a Code Signing EKU, rejects a certificate marked as a CA, and checks validity/private-key presence. This matches `Trust-Publisher.ps1`'s acceptance policy for the relevant EKU and CA constraints. A build can no longer accept the missing-EKU or CA cases that the prompted trust helper would reject.

Isolated PowerShell validation extracted `Test-CodeSigningCertificate` from the script AST. The full script parsed successfully; fabricated objects confirmed missing EKU and CA certificates are rejected and a valid non-CA Code Signing certificate is accepted. The existing current-user `CN=Hover Island` certificate also passed. No certificate was created or imported.

## Reviewed contracts

- `VerifyOnly` returns after hash, manifest, certificate, and MSIX signature verification, before any certificate import or package install. The reviewed path does not mutate trust or package state.
- Local publisher approval imports the signing leaf into `LocalMachine\TrustedPeople`; it does not add a root. The prompt precedes the elevated helper, which rechecks thumbprint, validity, EKU, and CA status.
- The manifest package identity matches `tauri.conf.json` (`com.hoverisland.app`), and its `HoverIsland` application ID matches the install launch AUMID suffix.
- App config/settings and notes use Tauri `app_config_dir`; the installer copies legacy `%APPDATA%\com.hoverisland.app` into the MSIX redirected `LocalCache\Roaming\com.hoverisland.app` only when that destination is absent. It leaves the legacy source intact and does not overwrite existing packaged data.

## Limits

This was static and isolated-function validation only. No package was built, no MSIX signature was checked against Windows policy, and install or first-run data migration was not exercised.
