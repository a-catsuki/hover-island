# Bluetooth device management

Hover Island lists paired Bluetooth devices and reports the connection state Windows exposes. The list is read-only until the user chooses an action. The app sends opaque device keys to the UI; raw Windows device identifiers stay in the native layer.

| Capability | Behavior |
| --- | --- |
| Paired-device list | Enumerates paired classic and LE Bluetooth devices with a bounded native query. |
| Connection state | Uses Windows' device property when available and the matching Windows audio endpoint for audio devices. A missing value is shown as unavailable. |
| Audio connect/disconnect | Offered only when an exact Windows device-container match exists and the corresponding Bluetooth audio KS property reports support. The request runs on a dedicated STA worker and is followed by endpoint-state readback. Unsupported drivers fall back to Windows Settings. |
| Keyboards, HID, BLE, and other non-audio devices | Windows owns their connection behavior; Hover Island does not claim to connect them on demand. Use Windows Bluetooth Settings. |
| Forget | Available as an explicit, separately confirmed action. The native command rechecks pairing and verifies that Windows removed the device. |
| Pair new devices | Opens `ms-settings:bluetooth`; pairing stays in Windows Settings. |
| Battery | Shown only when Windows provides a valid percentage. It is omitted otherwise. |

The native list and unpair operations run off the UI thread, bound asynchronous WinRT waits, limit results, and never trigger a radio reset or device reset. Audio state-change actions are user-triggered only. They are not exercised by automated tests because they change live device state.

The device-list UI refreshes periodically and after actions. It does not optimistically change connection state. If Bluetooth properties or the Windows audio service are unavailable, the paired list remains available when possible and connection controls stay disabled with a Windows Settings fallback.
