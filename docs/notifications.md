# Windows notification access and MSIX packaging

The normal Tauri configuration still produces an NSIS installer. That installer
is an unpackaged desktop app without package identity or a Windows package
manifest, so it does not declare the `userNotificationListener` capability.
Microsoft requires that capability in the app manifest and a separate user
grant before `UserNotificationListener` can return notification data. The
manifest uses `uap3:Capability`, the namespace Microsoft specifies for this
capability.

`packaging/windows/Build-Msix.ps1` builds an optional full MSIX around an
already compiled `hover-island.exe`. It picks `src-tauri/target/release` first,
then `debug`, or accepts `-ExecutablePath`. It stages adjacent DLL dependencies
and generates the required 44x44, 150x150, and 50x50 package logos from
`src-tauri/icons/icon.png`. The manifest declares a full-trust desktop
application, `runFullTrust`, and `userNotificationListener`. It reads the
package version from `src-tauri/tauri.conf.json`.

From the repository root, run:

```powershell
.\packaging\windows\Build-Msix.ps1
```

The script writes to `src-tauri/target/msix` by default and does not install the
package, register identity, create or trust a certificate, or overwrite an
existing package/staging directory. Without `-PfxPath`, it makes an unsigned
package using Microsoft's special unsigned-package publisher identity. For a
signed package, pass a PFX path; the script prompts for its password with hidden
input, uses the PFX subject as the manifest publisher, and signs with the
Windows SDK SignTool. The password is not printed or saved. Signing alone does
not make the certificate trusted on a machine, and the script never changes
trust settings.

MakeAppx performs its built-in package validation, which is useful but limited
and does not guarantee that Windows will install the package. The unsigned MSIX
is suitable as a build artifact, not normal distribution. Installing it still
requires a trusted signature or Windows 11's explicit unsigned-install path;
this script intentionally does neither. Microsoft requires notification access
to be requested on the UI thread, requires checking current access status on
each poll, and notes that revoked permission can produce an empty result rather
than an error. The native code handles retry and runtime errors accordingly.

## Verification status

The PowerShell parser and XML parser accepted the script and manifest. Windows
SDK 10.0.26100 MakeAppx successfully built an unsigned package from the fresh
13 October debug executable and validated the manifest and referenced assets.
The final package is recorded in `docs/verification/build.json`. The unused
DLL from the former dynamic-library build is excluded. No package install, certificate trust change,
permission prompt, or notification read was performed. Windows API access with
the signed identity and a user's permission remains a runtime verification step.

References:

- [Microsoft: Notification listener](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/notification-listener)
- [Microsoft: App capability declarations](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations)
- [Microsoft: `uap3:Capability` schema](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-uap3-capability-manual)
- [Microsoft: Create an app package with MakeAppx](https://learn.microsoft.com/en-us/windows/msix/package/create-app-package-with-makeappx-tool)
- [Microsoft: Unsigned packages](https://learn.microsoft.com/en-us/windows/msix/package/unsigned-package)
- [Microsoft: Full-trust desktop app package requirements](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-manual-conversion)
