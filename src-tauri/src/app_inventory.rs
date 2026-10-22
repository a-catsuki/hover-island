//! Read app inventory through the Shell and registry without a PowerShell runtime.
#[derive(Default)]
pub(crate) struct Inventory {
    pub packaged: Vec<(String, String)>,
    pub desktop: Vec<(String, String, String)>,
}

#[cfg(windows)]
mod platform {
    use super::Inventory;
    use windows::core::{w, ComInterface, GUID, PCWSTR, PWSTR};
    use windows::Win32::System::Com::{
        CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Registry::*;
    use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;
    use windows::Win32::UI::Shell::{
        BHID_EnumItems, IEnumShellItems, IShellItem, IShellItem2, SHCreateItemFromParsingName,
        SIGDN_NORMALDISPLAY,
    };

    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }
    struct Key(HKEY);
    impl Drop for Key {
        fn drop(&mut self) {
            let _ = unsafe { RegCloseKey(self.0) };
        }
    }
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }
    fn take_string(value: PWSTR) -> String {
        let text = unsafe { value.to_string() }.unwrap_or_default();
        unsafe { CoTaskMemFree(Some(value.0.cast())) };
        text
    }
    fn text(key: HKEY, name: &str) -> String {
        let name = wide(name);
        let mut bytes = 0;
        let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
        if unsafe {
            RegGetValueW(
                key,
                PCWSTR::null(),
                PCWSTR(name.as_ptr()),
                flags,
                None,
                None,
                Some(&mut bytes),
            )
        }
        .is_err()
            || bytes > 64 * 1024
        {
            return String::new();
        }
        let mut buffer = vec![0u16; (bytes as usize + 1) / 2];
        if unsafe {
            RegGetValueW(
                key,
                PCWSTR::null(),
                PCWSTR(name.as_ptr()),
                flags,
                None,
                Some(buffer.as_mut_ptr().cast()),
                Some(&mut bytes),
            )
        }
        .is_err()
        {
            return String::new();
        }
        let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        String::from_utf16_lossy(&buffer[..len])
    }
    fn number(key: HKEY, name: &str) -> u32 {
        let name = wide(name);
        let mut value = 0u32;
        let mut bytes = 4;
        let _ = unsafe {
            RegGetValueW(
                key,
                PCWSTR::null(),
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_DWORD,
                None,
                Some((&mut value as *mut u32).cast()),
                Some(&mut bytes),
            )
        };
        value
    }
    fn packaged(out: &mut Inventory) {
        if unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_err() {
            return;
        }
        let _apartment = Apartment;
        let Ok(folder): Result<IShellItem, _> =
            (unsafe { SHCreateItemFromParsingName(w!("shell:AppsFolder"), None) })
        else {
            return;
        };
        let Ok(items): Result<IEnumShellItems, _> =
            (unsafe { folder.BindToHandler(None, &BHID_EnumItems) })
        else {
            return;
        };
        let id_key = PROPERTYKEY {
            fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
            pid: 5,
        };
        for _ in 0..1500 {
            let mut next = [None];
            let mut fetched = 0;
            if unsafe { items.Next(&mut next, Some(&mut fetched)) }.is_err() || fetched == 0 {
                break;
            }
            let Some(item) = next[0].take() else {
                continue;
            };
            let Ok(properties) = item.cast::<IShellItem2>() else {
                continue;
            };
            let Ok(id) = (unsafe { properties.GetString(&id_key) }) else {
                continue;
            };
            let id = take_string(id);
            // Desktop shortcuts are already read directly from the Start Menu.
            if !id.contains('!') {
                continue;
            }
            if let Ok(name) = unsafe { item.GetDisplayName(SIGDN_NORMALDISPLAY) } {
                let name = take_string(name);
                if !name.is_empty() {
                    out.packaged.push((name, id));
                }
            }
        }
    }
    pub fn read() -> Inventory {
        let mut out = Inventory::default();
        packaged(&mut out);
        for (root, view) in [
            (HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY),
            (HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY),
            (HKEY_CURRENT_USER, KEY_WOW64_64KEY),
        ] {
            let mut raw = HKEY::default();
            if unsafe {
                RegOpenKeyExW(
                    root,
                    w!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
                    0,
                    KEY_READ | view,
                    &mut raw,
                )
            }
            .is_err()
            {
                continue;
            }
            let parent = Key(raw);
            for index in 0..4096 {
                let mut name = [0u16; 256];
                let mut len = name.len() as u32;
                if unsafe {
                    RegEnumKeyExW(
                        parent.0,
                        index,
                        PWSTR(name.as_mut_ptr()),
                        &mut len,
                        None,
                        PWSTR::null(),
                        None,
                        None,
                    )
                }
                .is_err()
                {
                    break;
                }
                let mut raw = HKEY::default();
                if unsafe {
                    RegOpenKeyExW(
                        parent.0,
                        PCWSTR(name.as_ptr()),
                        0,
                        KEY_READ | view,
                        &mut raw,
                    )
                }
                .is_err()
                {
                    continue;
                }
                let key = Key(raw);
                if number(key.0, "SystemComponent") != 0 || !text(key.0, "ParentKeyName").is_empty()
                {
                    continue;
                }
                let display = text(key.0, "DisplayName");
                if !display.is_empty() {
                    out.desktop.push((
                        display,
                        text(key.0, "DisplayIcon"),
                        text(key.0, "InstallLocation"),
                    ));
                }
            }
        }
        out
    }
}

pub(crate) fn read() -> Inventory {
    #[cfg(windows)]
    {
        platform::read()
    }
    #[cfg(not(windows))]
    {
        Inventory::default()
    }
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    #[ignore = "reads the current Windows app inventory"]
    fn live_native_inventory_has_packaged_and_desktop_apps() {
        let inventory = super::read();
        eprintln!(
            "Native inventory: {} packaged, {} desktop",
            inventory.packaged.len(),
            inventory.desktop.len()
        );
        assert!(!inventory.packaged.is_empty());
        assert!(!inventory.desktop.is_empty());
        assert!(inventory
            .packaged
            .iter()
            .all(|(name, id)| !name.is_empty() && id.contains('!')));
    }
}
