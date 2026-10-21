//! タブごとのファイル所属・監視パターン・閉じた履歴。
//!
//! ファイルの実体 (`Registry`) はタブに依存せず1つで、どのタブも持たなくなったときだけ解放する。
//! 監視パターンと閉じた履歴はタブ単位で持ち、タブを閉じると一緒に消える。

use crate::pattern::WatchPattern;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

type Key = (String, PathBuf);

#[derive(Default)]
pub struct Tabs {
    /// タブが持つファイル
    members: HashSet<Key>,
    /// タブで閉じたファイル。そのタブの監視パターンが再度開かないようにする
    closed: HashSet<Key>,
    patterns: Vec<WatchPattern>,
}

fn key(tab: &str, path: &Path) -> Key {
    (tab.to_string(), path.to_path_buf())
}

impl Tabs {
    pub fn restore_closed(&mut self, closed: impl IntoIterator<Item = (String, PathBuf)>) {
        self.closed.extend(closed);
    }

    pub fn closed(&self) -> Vec<(String, PathBuf)> {
        self.closed.iter().cloned().collect()
    }

    pub fn patterns(&self) -> Vec<WatchPattern> {
        self.patterns.clone()
    }

    /// 明示的に開いたものとして、タブに加え、そのタブの閉じた履歴から外す。
    pub fn add_member(&mut self, tab: &str, path: &Path) {
        self.closed.remove(&key(tab, path));
        self.members.insert(key(tab, path));
    }

    pub fn is_referenced(&self, path: &Path) -> bool {
        self.members.iter().any(|(_, member)| member == path)
    }

    /// パターンを `tab` のものとして登録する。同じ (パターン, タブ) が既にあれば false。
    pub fn add_pattern(&mut self, tab: &str, mut pattern: WatchPattern) -> bool {
        pattern.tab = tab.to_string();
        if self.patterns.contains(&pattern) {
            return false;
        }
        self.patterns.push(pattern);
        true
    }

    /// タブからファイルを外し、閉じた履歴に記録する。どのタブも持たなくなったら true。
    pub fn close_file(&mut self, tab: &str, path: &Path) -> bool {
        self.members.remove(&key(tab, path));
        self.closed.insert(key(tab, path));
        !self.is_referenced(path)
    }

    /// タブのパターンと履歴を消す。戻り値は、消したパターンと、どのタブも持たなくなったファイル。
    pub fn close_tab(&mut self, tab: &str) -> (Vec<WatchPattern>, Vec<PathBuf>) {
        let (removed, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut self.patterns)
            .into_iter()
            .partition(|pattern| pattern.tab == tab);
        self.patterns = kept;
        self.closed.retain(|(owner, _)| owner != tab);
        let owned: Vec<PathBuf> = self
            .members
            .iter()
            .filter(|(owner, _)| owner == tab)
            .map(|(_, path)| path.clone())
            .collect();
        self.members.retain(|(owner, _)| owner != tab);
        let released = owned
            .into_iter()
            .filter(|path| !self.is_referenced(path))
            .collect();
        (removed, released)
    }

    /// パターンが `tab` に加えるべきファイルか。タブが持っている、またはタブで閉じたものは対象外。
    pub fn should_add(&self, tab: &str, path: &Path) -> bool {
        let key = key(tab, path);
        !self.members.contains(&key) && !self.closed.contains(&key)
    }

    /// 変更されたパスのうち、パターンに一致して、そのタブへ加えるべき (タブ, パス)。
    pub fn pending_additions(&self, paths: &[PathBuf]) -> Vec<(String, PathBuf)> {
        let mut found: Vec<(String, PathBuf)> = Vec::new();
        for path in paths {
            for pattern in &self.patterns {
                let candidate = (pattern.tab.clone(), path.clone());
                if pattern.matches(path)
                    && self.should_add(&pattern.tab, path)
                    && !found.contains(&candidate)
                {
                    found.push(candidate);
                }
            }
        }
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pattern(base: &str) -> WatchPattern {
        WatchPattern {
            base: PathBuf::from(base),
            recursive: false,
            glob: None,
            tab: String::new(),
        }
    }

    #[test]
    fn same_pattern_registers_once_per_tab() {
        let mut tabs = Tabs::default();
        assert!(tabs.add_pattern("a", pattern("/d")));
        assert!(!tabs.add_pattern("a", pattern("/d")));
        assert!(tabs.add_pattern("b", pattern("/d")));
        assert_eq!(tabs.patterns().len(), 2);
    }

    #[test]
    fn file_is_released_only_when_no_tab_holds_it() {
        let mut tabs = Tabs::default();
        let path = Path::new("/d/a.md");
        tabs.add_member("a", path);
        tabs.add_member("b", path);
        assert!(!tabs.close_file("a", path));
        assert!(tabs.is_referenced(path));
        assert!(tabs.close_file("b", path));
        assert!(!tabs.is_referenced(path));
    }

    #[test]
    fn closed_file_is_not_added_back_by_the_pattern_of_that_tab() {
        let mut tabs = Tabs::default();
        let path = PathBuf::from("/d/a.md");
        tabs.add_pattern("a", pattern("/d"));
        tabs.add_pattern("b", pattern("/d"));
        tabs.add_member("a", &path);
        tabs.close_file("a", &path);
        // a は閉じたので除外され、b はまだ持っていないので対象になる
        assert_eq!(
            tabs.pending_additions(std::slice::from_ref(&path)),
            vec![("b".to_string(), path.clone())]
        );
    }

    #[test]
    fn new_file_goes_to_every_matching_tab() {
        let mut tabs = Tabs::default();
        tabs.add_pattern("a", pattern("/d"));
        tabs.add_pattern("b", pattern("/d"));
        tabs.add_pattern("c", pattern("/other"));
        let added = tabs.pending_additions(&[PathBuf::from("/d/new.md")]);
        assert_eq!(
            added,
            vec![
                ("a".to_string(), PathBuf::from("/d/new.md")),
                ("b".to_string(), PathBuf::from("/d/new.md")),
            ]
        );
    }

    #[test]
    fn explicit_open_clears_the_closed_entry_of_that_tab_only() {
        let mut tabs = Tabs::default();
        let path = Path::new("/d/a.md");
        tabs.add_pattern("a", pattern("/d"));
        tabs.add_pattern("b", pattern("/d"));
        tabs.close_file("a", path);
        tabs.close_file("b", path);
        tabs.add_member("a", path);
        assert!(!tabs.should_add("a", path)); // 持っている
        assert!(!tabs.should_add("b", path)); // b では閉じたまま
    }

    #[test]
    fn closing_a_tab_drops_its_patterns_history_and_unshared_files() {
        let mut tabs = Tabs::default();
        let shared = Path::new("/d/shared.md");
        let own = Path::new("/d/own.md");
        tabs.add_pattern("a", pattern("/d"));
        tabs.add_pattern("b", pattern("/d"));
        tabs.add_member("a", shared);
        tabs.add_member("b", shared);
        tabs.add_member("a", own);
        tabs.close_file("a", Path::new("/d/x.md"));

        let (patterns, released) = tabs.close_tab("a");
        assert_eq!(patterns.len(), 1);
        assert_eq!(patterns[0].tab, "a");
        assert_eq!(released, vec![own.to_path_buf()]);
        assert!(tabs.is_referenced(shared));
        assert!(tabs.closed().is_empty());
        assert_eq!(tabs.patterns().len(), 1);
    }
}
