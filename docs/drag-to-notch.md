# Drag files to the notch

Explorer files and folders open a compact destination chooser instead of the dashboard. The left target is Recycle Bin; the right target adds to the phone Beam bucket. The center is deliberately inert. Hover only previews an action: releasing on the target performs it, and leaving or cancelling performs neither action.

The existing island spring reshapes the notch to 366 by 92 logical pixels on horizontal edges and 420 by 110 on side edges. Targets follow the visible clipped frame, including bar and sidebar modes. Windows drag positions are physical webview-local pixels and are converted to CSS coordinates before hit testing. Native hit testing uses matching bounds while the drag is active. Hover expansion and cursor attraction are suppressed during file drags; result timers cannot overwrite a newer drag.

## Recycle Bin

The native command accepts only the most recent OS-reported drop payload, once, within two minutes. It rejects roots, protected system paths, overlapping selections, network drives and aliases/reparse paths. Windows Shell runs on a separate STA worker with recycle and undo flags. A potential permanent-delete fallback requires Windows' explicit warning; the app has no filesystem-delete fallback. Per-item Shell results and cancellation drive the result feedback. Canonical extended-length filesystem paths are converted to normal Shell parsing names before creating the Shell item.

The optional `recycle::tests::shell_recycles_only_an_owned_temporary_fixture` smoke creates one disposable temporary text file, moves only that file to Windows Recycle Bin, verifies removal/result counts and proves authorization cannot be reused. It does not empty Recycle Bin or touch pre-existing user files.

## Beam

The same one-use native drop authorization gates file staging. Files are streamed through the existing authenticated bucket upload pipeline, preserving its cancellation, quota, non-overwrite and progress behavior. Folders become stored ZIP archives retaining nested paths. Folder walks reject links/special files and are bounded by 32 levels, 500 files, 1,000 total entries and 95 MB of source bytes. The bucket retains its 100 MB per-file, 50-item and 500 MB limits. Source files are copied, never moved to the bucket. Empty folders are reported as having no shareable files.

The phone still uses the temporary local QR page. This feature does not make AirDrop or iPhone Dynamic Island integration available.

## Verification

The browser preview never recycles real files or claims successful native Beam uploads. `tests/file-drop-targets.test.mjs` exercises the production coordinate conversion and release gates. `docs/verification/drop-toast-preview.mjs` checks visible target bounds, highlighting, inert center, hover suppression and leave behavior across eight notch/bar/sidebar edge combinations at device scale factor two. Real Explorer-to-webview event delivery and physical phone networking remain separate device checks.
