# Windows quick controls and memory reclaim

Quick controls use supported Windows interfaces and keep their limits visible in the UI:

- **Night Light** opens `ms-settings:nightlight`. Windows documents this URI for launching the Settings page; Hover Island does not write private Night Light state or imitate a toggle.
- **Bluetooth** reads the WinRT radio state. A user-triggered change starts `Radio.RequestAccessAsync` on Tauri's UI thread (where Windows can present consent) and waits for its asynchronous result on a worker. It requests access once per app session and only calls `SetStateAsync` after Windows grants radio-control access. If Windows denies access, the widget reports the denial, links to Bluetooth Settings, and retries permission only after the user returns from Settings. The MSIX manifest declares the documented `radios` device capability; unpackaged runs surface API availability errors rather than faking state.
- **Power saver** switches to the built-in Power saver power plan when that plan exists. Enabling records the plan that was active and disabling restores that plan only while Power saver remains active. If another app changes the plan, Hover Island leaves it unchanged. This is a power-plan action; it is not presented as the separate Windows Energy Saver setting. If the plan is unavailable or was already active before Hover Island started, the widget offers Windows power settings instead of guessing which plan to restore.
- **Memory reclaim** scans only on explicit user request. It previews background processes from the current user and session, excludes visible/foreground app processes and their descendants, Windows/system/security processes, media apps, and Hover Island, and requires the user to select each process. Before each operation, it verifies the PID creation time, session, owner, path, visibility, and critical-process status again on the final handle. The only operation is the documented `EmptyWorkingSet` API. It never terminates or suspends processes, elevates privileges, or purges caches or files.

The reported reclaim amount is the measured working-set decrease immediately after the API call. Windows may reload those pages later; this number is not a promise of permanently freed physical memory or improved speed.

Microsoft references:

- [Launch Windows Settings and the `ms-settings:` URI list](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-settings)
- [`Radio.RequestAccessAsync`](https://learn.microsoft.com/en-us/uwp/api/windows.devices.radios.radio.requestaccessasync)
- [Power scheme management](https://learn.microsoft.com/en-us/windows/win32/power/managing-power-schemes)
- [`EmptyWorkingSet`](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-emptyworkingset)
