//! Curated catalog of connected web apps. Contains no secrets; the frontend seeds
//! and merges these against the user's saved `connections`.
use crate::types::AppConnection;

pub fn catalog() -> Vec<AppConnection> {
    [
        (
            "whatsapp",
            "WhatsApp",
            "https://web.whatsapp.com/",
            &["WhatsApp", "WhatsApp Desktop"] as &[&str],
        ),
        ("gmail", "Gmail", "https://mail.google.com/", &["Gmail"]),
        (
            "instagram",
            "Instagram",
            "https://www.instagram.com/",
            &["Instagram"],
        ),
        (
            "outlook",
            "Outlook",
            "https://outlook.live.com/mail/",
            &["Outlook", "Microsoft Outlook"],
        ),
        ("slack", "Slack", "https://app.slack.com/client", &["Slack"]),
        (
            "discord",
            "Discord",
            "https://discord.com/app",
            &["Discord"],
        ),
        (
            "telegram",
            "Telegram",
            "https://web.telegram.org/",
            &["Telegram"],
        ),
        ("notion", "Notion", "https://www.notion.so/", &["Notion"]),
        ("x", "X", "https://x.com/", &["X"]),
    ]
    .into_iter()
    .map(|(id, name, url, notification_sources)| AppConnection {
        id: id.into(),
        name: name.into(),
        url: url.into(),
        icon: None,
        notifications: true,
        notification_sources: notification_sources.iter().map(|s| s.to_string()).collect(),
    })
    .collect()
}

#[tauri::command]
pub fn connections_list() -> Vec<AppConnection> {
    catalog()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_clean_and_unique() {
        let items = catalog();
        assert_eq!(items.len(), 9);
        let mut ids: Vec<&str> = items.iter().map(|c| c.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), items.len());
        for item in &items {
            assert!(item.url.starts_with("https://"));
            assert!(item.notifications);
            assert!(item.icon.is_none());
            assert!(!item.notification_sources.is_empty());
        }
    }
}
