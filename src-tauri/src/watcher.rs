//! ディレクトリ単位のファイル監視。
//!
//! 多くのエディタは一時ファイルへ書き込んでから rename で保存する。
//! ファイル単位で監視すると inode が変わった時点で通知が途絶えるため、
//! 親ディレクトリを監視し、イベントのパスから登録済みファイルを判定する。
//! 同じディレクトリを複数の用途 (開いたファイルの親、監視パターン) で監視するときは
//! 参照カウントで watch を共有し、再帰指定が1つでもあれば再帰監視にする。

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

type FileDebouncer = Debouncer<RecommendedWatcher, RecommendedCache>;

struct Entry {
    count: usize,
    recursive: bool,
}

pub struct DirWatcher {
    inner: Mutex<Inner>,
}

struct Inner {
    debouncer: FileDebouncer,
    entries: HashMap<PathBuf, Entry>,
}

fn mode(recursive: bool) -> RecursiveMode {
    if recursive {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    }
}

impl DirWatcher {
    /// `on_changed` にはデバウンス済みのイベントのパス一覧が渡される。
    /// 呼び出し元のスレッドはデバウンサ内部のため、重い処理は別スレッドへ渡すこと。
    pub fn new(on_changed: impl Fn(Vec<PathBuf>) + Send + 'static) -> notify::Result<Self> {
        let debouncer = new_debouncer(
            Duration::from_millis(100),
            None,
            move |result: DebounceEventResult| {
                if let Ok(events) = result {
                    let paths: Vec<PathBuf> = events
                        .into_iter()
                        .filter(|event| !event.kind.is_access())
                        .flat_map(|event| event.paths.clone())
                        .collect();
                    if !paths.is_empty() {
                        on_changed(paths);
                    }
                }
            },
        )?;
        Ok(Self {
            inner: Mutex::new(Inner {
                debouncer,
                entries: HashMap::new(),
            }),
        })
    }

    /// `dir` の監視を1つ増やす。Err のときは状態を変えない (呼び出し元は `unwatch_dir` を呼ばないこと)。
    pub fn watch_dir(&self, dir: &Path, recursive: bool) -> notify::Result<()> {
        let mut inner = self.inner.lock().unwrap();
        if let Some(entry) = inner.entries.get(dir) {
            let upgrade = recursive && !entry.recursive;
            // 再帰への切り替えに失敗したとき、フラグだけ立って再試行されなくならないよう、成功後に更新する
            if upgrade {
                inner.debouncer.watch(dir, RecursiveMode::Recursive)?;
            }
            let entry = inner.entries.get_mut(dir).expect("entry exists");
            entry.count += 1;
            entry.recursive |= upgrade;
            return Ok(());
        }
        inner.debouncer.watch(dir, mode(recursive))?;
        inner.entries.insert(
            dir.to_path_buf(),
            Entry {
                count: 1,
                recursive,
            },
        );
        Ok(())
    }

    pub fn unwatch_dir(&self, dir: &Path) {
        let mut inner = self.inner.lock().unwrap();
        let Some(entry) = inner.entries.get_mut(dir) else {
            return;
        };
        entry.count -= 1;
        if entry.count == 0 {
            inner.entries.remove(dir);
            let _ = inner.debouncer.unwatch(dir);
        }
    }

    pub fn watch_file(&self, file: &Path) -> notify::Result<()> {
        match file.parent() {
            Some(dir) => self.watch_dir(dir, false),
            None => Ok(()),
        }
    }

    pub fn unwatch_file(&self, file: &Path) {
        if let Some(dir) = file.parent() {
            self.unwatch_dir(dir);
        }
    }

    /// テスト用: `dir` の (参照数, 再帰か)
    #[cfg(test)]
    pub(crate) fn entry(&self, dir: &Path) -> Option<(usize, bool)> {
        let inner = self.inner.lock().unwrap();
        inner
            .entries
            .get(dir)
            .map(|entry| (entry.count, entry.recursive))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_directory_is_reference_counted() {
        let dir = tempfile::tempdir().unwrap();
        let watcher = DirWatcher::new(|_| {}).unwrap();
        watcher.watch_dir(dir.path(), false).unwrap();
        watcher.watch_dir(dir.path(), true).unwrap();
        assert_eq!(watcher.entry(dir.path()), Some((2, true)));
        watcher.unwatch_dir(dir.path());
        assert_eq!(watcher.entry(dir.path()), Some((1, true)));
        watcher.unwatch_dir(dir.path());
        assert_eq!(watcher.entry(dir.path()), None);
    }

    #[test]
    fn failed_watch_leaves_no_entry() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        let watcher = DirWatcher::new(|_| {}).unwrap();
        assert!(watcher.watch_dir(&missing, false).is_err());
        assert_eq!(watcher.entry(&missing), None);
    }

    #[test]
    fn failed_recursive_upgrade_keeps_count_and_flag() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        let watcher = DirWatcher::new(|_| {}).unwrap();
        watcher.watch_dir(&sub, false).unwrap();
        // 監視中のディレクトリを消すと、再帰監視への切り替えは失敗する
        std::fs::remove_dir(&sub).unwrap();
        assert!(watcher.watch_dir(&sub, true).is_err());
        assert_eq!(watcher.entry(&sub), Some((1, false)));
    }
}
