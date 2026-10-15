HOVER ISLAND - WINDOWS INSTALLATION

1. Keep this folder together and double-click Install.cmd.
2. For this personal build, approve the local publisher when the installer asks.
   Windows will show an administrator prompt to trust the signing certificate.
   No root certificate is installed. The build's private signing key is not included.
3. Hover Island opens after installation. Later, open it from the Start menu.

ENABLE NATIVE ALERTS
Open Hover Island Settings > Notifications > Allow Windows alerts and choose Allow.
The app enables capture when access is granted. Select desktop apps in Connections.
You can also enable alerts from the first-run introduction.
Use Send test alert to check the notch, sound and collapsed alert badge.

Website alerts and calendars are optional. Add a supported website feed or a
Google/Outlook calendar subscription in Connections; no browser window needs to
stay open. Website shortcuts alone do not sign in to accounts or fetch inboxes.

File sharing uses a temporary QR page on the same network. If Windows asks,
allow Hover Island on your private network so your phone can reach the bucket.

This is a signed personal MSIX build, not a Microsoft Store release. Windows
requires the certificate approval once. Updates use the same local publisher.
The installer checks the package hash, signature and publisher before installation.
To inspect without installing: powershell -File Install.ps1 -VerifyOnly

The uninstall option in Windows removes the installed package. No cleanup of
your original standalone Hover Island notes or settings is performed by this installer.
