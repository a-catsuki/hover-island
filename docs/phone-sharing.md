# Phone file bucket

Open **Files** in the notch toolbar and select **Start session**. Scan the QR
with the phone camera while both devices use the same Wi-Fi. The phone opens
a temporary page; no phone app or account is required.

On the phone, choose files or photos, remove anything unwanted, then select
**Send to PC**. Received files are saved in **Downloads / Hover Island** and
produce a temporary notch expansion, unless DND or alerts are off. On the PC,
drop files onto the notch or use **Choose files**. The first drop starts a
session automatically. The phone's **Ready to download** list updates and
provides a Download button for each file. The toolbar finds the bucket in its
chosen panel without changing the user's widget arrangement.

Drop a folder or use **Choose folder** to add a path-preserving ZIP. Folder
selection is bounded to 500 entries and 95 MB. The phone page notices newly
added PC files and offers **Download all ZIP**. That ZIP streams directly from
the bucket without making another archive on disk or holding all files in RAM.
Sending and receiving show progress, completion and failure expansions in the
notch. An iPhone system Dynamic Island alert requires a native iOS companion;
the QR webpage provides its own live transfer interface.

The session lasts 30 minutes and can be stopped early. Stop cancels queued
uploads and closes access; files already saved remain on the PC. Limits are
100 MiB per file, 500 MiB and 50 files per session. Duplicate names receive
numbered filenames rather than replacing existing data. Uploads stream to
disk rather than accumulating whole files in memory.

This uses local HTTP and a random bearer URL, with no cloud relay. Anyone
with that session link can access its bucket. It is not AirDrop or an
encrypted transport. The QR is generated locally. Browser origins, session
expiry, filenames, byte counts, concurrency and upload timeouts are checked.

If the phone cannot connect, check the same Wi-Fi, guest-network isolation,
VPN routing and Windows' private-network firewall prompt. No firewall rules,
drivers or security settings are changed automatically.

Verification: native HTTP tests exercise authentication, origin rejection,
limits, no-overwrite saves and exact upload/download bytes. Mobile Chromium
also stages/removes/sends files and downloads PC-staged bytes against the real
Rust router. A physical iPhone, its local-network permissions and the actual
Wi-Fi/firewall path remain to be tested.
