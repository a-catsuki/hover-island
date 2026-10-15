# Remembered phones

Open Beam from the expanded toolbar, or drop files on the right side of the compact drag chooser. Start the temporary bucket and scan its QR code. The phone requests pairing with a name and a six-digit code; approve the matching request on the PC. Save the phone's `/device` page as a bookmark to reopen a future active bucket without pairing again.

The server prefers port 47692 and falls back to another available port. A changed PC address or fallback port can require scanning a new QR code. A remembered phone is shown as present only after a recent request to the current session; remembering a device does not wake its browser. iPhone AirDrop popups and Dynamic Island integration are not provided by this local website.

Pair requests expire in two minutes and are bound to the requesting IP. File APIs require the approved phone cookie; unpaired browsers cannot list files. Cookies are HttpOnly and SameSite Strict; the PC persists only their hashes. Removing a remembered device revokes access. Trust-store replacement preserves the previous list if Windows prevents a write.

Buckets expire after 30 minutes or Stop. Folder drops are staged as bounded ZIP archives; original files stay in place. The left drag target instead uses Windows Recycle Bin with a one-use authorization for the exact native drop paths.

Verification covers native upload/download/authentication, a real browser pairing/bookmark flow on localhost, and an exclusive-file-lock trust-store failure. Physical iPhone networking and firewall consent remain separate device checks.
