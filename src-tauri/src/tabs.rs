//! タブごとのファイル所属・監視パターン・閉じた履歴。
//!
//! ファイルの実体 (`Registry`) はタブに依存せず1つで、どのタブも持たなくなったときだけ解放する。
//! 監視パターンと閉じた履歴はタブ単位で持ち、タブを閉じると一緒に消える。

use crate::pattern::WatchPattern;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

type Key = (String, PathBuf);

/// 閉じた履歴の上限。任意の `tab_id` で `close_file` を呼べるため、上限がないとセッションが際限なく増える。
/// 超えたら古いものから捨てる (捨てたファイルは監視パターンが再び開きうる)
pub const MAX_CLOSED_FILES: usize = 1000;

#[derive(Default)]
pub struct Tabs {
    /// タブが持つファイル
    members: HashSet<Key>,
    /// タブで閉じたファイルと、閉じた順の通し番号。そのタブの監視パターンが再度開かないようにする
    closed: HashMap<Key, u64>,
    next_closed: u64,
    patterns: Vec<WatchPattern>,
}

fn key(tab: &str, path: &Path) -> Key {
    (tab.to_string(), path.to_path_buf())
}

impl Tabs {
    /// 古い順に渡す。上限を超えた分は古いものから捨てる。
    pub fn restore_closed(&mut self, closed: impl IntoIterator<Item = (String, PathBuf)>) {
        for key in closed {
            self.record_closed(key);
        }
    }

    /// 閉じた履歴を古い順に返す。
    pub fn closed(&self) -> Vec<(String, PathBuf)> {
        let mut entries: Vec<(&Key, &u64)> = self.closed.iter().collect();
        entries.sort_by_key(|(_, order)| **order);
        entries.into_iter().map(|(key, _)| key.clone()).collect()
    }

    fn record_closed(&mut self, key: Key) {
        self.closed.insert(key, self.next_closed);
        self.next_closed += 1;
        if self.closed.len() > MAX_CLOSED_FILES {
            if let Some(oldest) = self
                .closed
                .iter()
                .min_by_key(|(_, order)| **order)
                .map(|(key, _)| key.clone())
            {
                self.closed.remove(&oldest);
            }
        }
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

    /// 監視パターンによる自動追加。判定 (`pending_additions`) の後にタブが閉じられた・ファイルが閉じられた場合に
    /// タブを復活させたり閉じた履歴を消したりしないよう、加える直前に同じロック内で再判定する。加えたら true。
    pub fn add_pending(&mut self, tab: &str, path: &Path) -> bool {
        let matched = self
            .patterns
            .iter()
            .any(|pattern| pattern.tab == tab && pattern.matches(path));
        if !matched || !self.should_add(tab, path) {
            return false;
        }
        self.members.insert(key(tab, path));
        true
    }

    /// パターンを `tab` のものとして登録する。同じ (パターン, タブ) が既にあれば false。
    #[cfg(test)]
    pub fn add_pattern(&mut self, tab: &str, pattern: WatchPattern) -> bool {
        self.add_pattern_with(tab, pattern, |_| Ok::<(), ()>(()))
            .unwrap()
    }

    /// 新しいパターンなら `watch` で監視を始め、成功したときだけ `tab` のものとして登録する。
    /// 監視に失敗したパターンを登録すると、タブを閉じたときの `unwatch_dir` が他の用途の参照数を減らすため。
    /// 同じ (パターン, タブ) が既にあれば `watch` を呼ばずに Ok(false)。
    pub fn add_pattern_with<E>(
        &mut self,
        tab: &str,
        mut pattern: WatchPattern,
        watch: impl FnOnce(&WatchPattern) -> Result<(), E>,
    ) -> Result<bool, E> {
        pattern.tab = tab.to_string();
        if self.patterns.contains(&pattern) {
            return Ok(false);
        }
        watch(&pattern)?;
        self.patterns.push(pattern);
        Ok(true)
    }

    /// タブからファイルを外し、閉じた履歴に記録する。どのタブも持たなくなったら true。
    pub fn close_file(&mut self, tab: &str, path: &Path) -> bool {
        self.members.remove(&key(tab, path));
        self.record_closed(key(tab, path));
        !self.is_referenced(path)
    }

    /// タブのパターンと履歴を消す。戻り値は、消したパターンと、どのタブも持たなくなったファイル。
    pub fn close_tab(&mut self, tab: &str) -> (Vec<WatchPattern>, Vec<PathBuf>) {
        let (removed, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut self.patterns)
            .into_iter()
            .partition(|pattern| pattern.tab == tab);
        self.patterns = kept;
        self.closed.retain(|(owner, _), _| owner != tab);
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
        !self.members.contains(&key) && !self.closed.contains_key(&key)
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

    #[test]
    fn pattern_is_registered_only_when_watch_succeeds() {
        let mut tabs = Tabs::default();
        assert_eq!(
            tabs.add_pattern_with("a", pattern("/d"), |_| Err("ENOSPC")),
            Err("ENOSPC")
        );
        assert!(tabs.patterns().is_empty());
        // 失敗後の再試行では監視をやり直す
        let mut watched = 0;
        let result = tabs.add_pattern_with("a", pattern("/d"), |_| {
            watched += 1;
            Ok::<(), &str>(())
        });
        assert_eq!(result, Ok(true));
        // 登録済みなら監視しない (参照数を増やさない)
        let result = tabs.add_pattern_with("a", pattern("/d"), |_| {
            watched += 1;
            Ok::<(), &str>(())
        });
        assert_eq!(result, Ok(false));
        assert_eq!(watched, 1);
        assert_eq!(tabs.patterns().len(), 1);
    }

    #[test]
    fn pending_addition_is_dropped_after_the_tab_is_closed() {
        let mut tabs = Tabs::default();
        let path = PathBuf::from("/d/new.md");
        tabs.add_pattern("a", pattern("/d"));
        assert_eq!(tabs.pending_additions(std::slice::from_ref(&path)).len(), 1);
        tabs.close_tab("a");
        assert!(!tabs.add_pending("a", &path));
        assert!(!tabs.is_referenced(&path));
    }

    #[test]
    fn pending_addition_keeps_a_file_closed_in_the_meantime() {
        let mut tabs = Tabs::default();
        let path = PathBuf::from("/d/new.md");
        tabs.add_pattern("a", pattern("/d"));
        assert_eq!(tabs.pending_additions(std::slice::from_ref(&path)).len(), 1);
        tabs.close_file("a", &path);
        assert!(!tabs.add_pending("a", &path));
        assert!(!tabs.should_add("a", &path)); // 閉じた履歴は残る
        assert!(tabs.add_pending("a", Path::new("/d/other.md")));
        assert!(tabs.is_referenced(Path::new("/d/other.md")));
        assert!(!tabs.add_pending("a", Path::new("/elsewhere/x.md")));
    }

    #[test]
    fn closed_history_keeps_the_most_recent_entries() {
        let mut tabs = Tabs::default();
        let path = |i: usize| PathBuf::from(format!("/d/{i}.md"));
        tabs.restore_closed((0..MAX_CLOSED_FILES).map(|i| ("a".to_string(), path(i))));
        tabs.close_file("a", &path(MAX_CLOSED_FILES));
        tabs.close_file("a", &path(1)); // 閉じ直すと新しい扱い
        tabs.close_file("a", &path(MAX_CLOSED_FILES + 1));
        let closed = tabs.closed();
        assert_eq!(closed.len(), MAX_CLOSED_FILES);
        assert!(!closed.contains(&("a".to_string(), path(0))));
        assert!(!closed.contains(&("a".to_string(), path(2))));
        assert_eq!(
            closed[closed.len() - 2..],
            [
                ("a".to_string(), path(1)),
                ("a".to_string(), path(MAX_CLOSED_FILES + 1))
            ]
        );
    }
}
