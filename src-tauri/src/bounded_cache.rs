//! Count and byte bounded LRU for native image caches.
use std::collections::HashMap;

struct Entry<V> {
    value: V,
    bytes: usize,
    touched: u64,
}
pub(crate) struct BoundedCache<V> {
    entries: HashMap<String, Entry<V>>,
    bytes: usize,
    max_bytes: usize,
    max_entries: usize,
    clock: u64,
}
impl<V> BoundedCache<V> {
    pub fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            bytes: 0,
            max_bytes,
            max_entries: max_entries.max(1),
            clock: 0,
        }
    }
    pub fn get(&mut self, key: &str) -> Option<&V> {
        self.clock = self.clock.saturating_add(1);
        let entry = self.entries.get_mut(key)?;
        entry.touched = self.clock;
        Some(&entry.value)
    }
    pub fn insert(&mut self, key: String, value: V, value_bytes: usize) {
        let bytes = value_bytes
            .saturating_add(key.capacity())
            .saturating_add(std::mem::size_of::<Entry<V>>() + std::mem::size_of::<String>());
        // Do not evict useful entries to retain one image bigger than the entire budget.
        if bytes > self.max_bytes {
            return;
        }
        if let Some(old) = self.entries.remove(&key) {
            self.bytes = self.bytes.saturating_sub(old.bytes);
        }
        while self.entries.len() >= self.max_entries
            || self.bytes.saturating_add(bytes) > self.max_bytes
        {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.touched)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some(old) = self.entries.remove(&oldest) {
                self.bytes = self.bytes.saturating_sub(old.bytes);
            }
        }
        self.clock = self.clock.saturating_add(1);
        self.bytes += bytes;
        self.entries.insert(
            key,
            Entry {
                value,
                bytes,
                touched: self.clock,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::BoundedCache;
    #[test]
    fn recent_icons_survive_count_eviction() {
        let mut cache = BoundedCache::new(2, 4096);
        cache.insert("a".into(), 1, 1);
        cache.insert("b".into(), 2, 1);
        assert_eq!(cache.get("a"), Some(&1));
        cache.insert("c".into(), 3, 1);
        assert_eq!(cache.get("b"), None);
        assert_eq!(cache.get("a"), Some(&1));
        assert_eq!(cache.get("c"), Some(&3));
    }
    #[test]
    fn large_icons_cannot_accumulate_past_the_byte_budget() {
        let mut cache = BoundedCache::new(96, 2048);
        for index in 0..256 {
            cache.insert(index.to_string(), index, 700);
            assert!(cache.bytes <= 2048);
        }
        assert!(cache.entries.len() <= 2);
        cache.insert("too big".into(), 999, 4096);
        assert_eq!(cache.get("255"), Some(&255));
        assert_eq!(cache.get("too big"), None);
    }
    #[test]
    fn replacing_an_icon_releases_its_previous_weight() {
        let mut cache = BoundedCache::new(96, 2048);
        cache.insert("a".into(), 1, 1024);
        let before = cache.bytes;
        cache.insert("a".into(), 2, 16);
        assert!(cache.bytes < before);
        assert_eq!(cache.entries.len(), 1);
    }
}
