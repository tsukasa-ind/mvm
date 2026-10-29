//! セッション (開いているファイルとタブ) の永続化。

use crate::pattern::WatchPattern;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTab {
    pub id: String,
    pub title: String,
    pub files: Vec<PathBuf>,
    pub active_file: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionFile {
    pub version: u32,
    pub tabs: Vec<SessionTab>,
    pub active_tab_id: String,
    pub patterns: Vec<WatchPattern>,
    /// 旧形式の閉じたファイル (タブの区別なし)。読み込み専用で、`main` の履歴として扱う
    #[serde(default, skip_serializing)]
    pub closed: Vec<PathBuf>,
    /// タブで閉じたファイル。そのタブの監視パターンによる自動追加の対象から外す。
    /// `closed` を書き換えないのは、旧バージョンが読んでセッションを失わないため
    #[serde(default)]
    pub closed_tabs: Vec<ClosedFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClosedFile {
    pub tab: String,
    pub path: PathBuf,
}

impl SessionFile {
    pub fn new(
        tabs: Vec<SessionTab>,
        active_tab_id: String,
        patterns: Vec<WatchPattern>,
        closed_tabs: Vec<ClosedFile>,
    ) -> Self {
        Self {
            version: VERSION,
            tabs,
            active_tab_id,
            patterns,
            closed: Vec::new(),
            closed_tabs,
        }
    }

    /// 旧形式の履歴を `main` の履歴として加えた、タブごとの閉じたファイル。
    pub fn closed_files(&self) -> Vec<ClosedFile> {
        let legacy = self.closed.iter().map(|path| ClosedFile {
            tab: "main".to_string(),
            path: path.clone(),
        });
        legacy.chain(self.closed_tabs.iter().cloned()).collect()
    }
}

/// 本体の直前の正常な内容。本体が壊れていたときの復元元
pub fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

/// ファイルが無い・壊れている・バージョン不一致のときは None。
fn read(path: &Path) -> Option<SessionFile> {
    let text = fs::read_to_string(path).ok()?;
    let session: SessionFile = serde_json::from_str(&text).ok()?;
    (session.version == VERSION).then_some(session)
}

/// 本体が読めないときは `.bak` から復元する。どちらも読めなければ None (セッションなしで起動する)。
pub fn load(path: &Path) -> Option<SessionFile> {
    read(path).or_else(|| {
        let restored = read(&backup_path(path))?;
        eprintln!("session restored from backup: {}", path.display());
        Some(restored)
    })
}

/// 一時ファイルへ書いて fsync してから rename し、書き込み途中や電源断での破損を避ける。
/// 正常に読める本体は rename の前に `.bak` へ退避する (壊れた本体で `.bak` を上書きしない)。
pub fn save(path: &Path, session: &SessionFile) -> io::Result<()> {
    let parent = path.parent().filter(|dir| !dir.as_os_str().is_empty());
    if let Some(parent) = parent {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    {
        let mut file = File::create(&tmp)?;
        file.write_all(&serde_json::to_vec_pretty(session)?)?;
        file.sync_all()?;
    }
    if read(path).is_some() {
        fs::rename(path, backup_path(path))?;
    }
    fs::rename(&tmp, path)?;
    if let Some(parent) = parent {
        sync_dir(parent);
    }
    Ok(())
}

/// rename をディレクトリエントリごと永続化する。Windows ではディレクトリを開けないため行わない (失敗は無視する)。
fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(dir) = File::open(dir) {
        let _ = dir.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> SessionFile {
        SessionFile::new(
            vec![SessionTab {
                id: "main".into(),
                title: "main".into(),
                files: vec![PathBuf::from("/d/a.md"), PathBuf::from("/d/b.md")],
                active_file: Some(PathBuf::from("/d/b.md")),
            }],
            "main".into(),
            vec![WatchPattern {
                base: PathBuf::from("/d"),
                recursive: true,
                glob: None,
                tab: "main".into(),
            }],
            vec![ClosedFile {
                tab: "main".into(),
                path: PathBuf::from("/d/closed.md"),
            }],
        )
    }

    #[test]
    fn roundtrip_preserves_session() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/session.json");
        save(&path, &sample()).unwrap();
        assert_eq!(load(&path), Some(sample()));
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn missing_corrupt_or_old_version_yields_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        assert_eq!(load(&path), None);
        fs::write(&path, "{ not json").unwrap();
        assert_eq!(load(&path), None);
        let mut old = sample();
        old.version = 0;
        fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
        assert_eq!(load(&path), None);
    }

    #[test]
    fn save_keeps_previous_session_as_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        let mut first = sample();
        first.active_tab_id = "first".into();
        save(&path, &first).unwrap();
        assert!(!backup_path(&path).exists());
        save(&path, &sample()).unwrap();
        assert_eq!(read(&path), Some(sample()));
        assert_eq!(read(&backup_path(&path)), Some(first));
    }

    #[test]
    fn corrupt_or_missing_session_is_restored_from_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        save(&path, &sample()).unwrap();
        save(&path, &sample()).unwrap();
        // 電源断で本体が空になった場合
        fs::write(&path, "").unwrap();
        assert_eq!(load(&path), Some(sample()));
        fs::write(&path, "{ not json").unwrap();
        assert_eq!(load(&path), Some(sample()));
        // 退避の rename の直後に止まった場合
        fs::remove_file(&path).unwrap();
        assert_eq!(load(&path), Some(sample()));
    }

    #[test]
    fn corrupt_session_does_not_overwrite_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        let mut good = sample();
        good.active_tab_id = "good".into();
        save(&path, &good).unwrap();
        save(&path, &good).unwrap();
        fs::write(&path, "").unwrap();
        save(&path, &sample()).unwrap();
        assert_eq!(read(&path), Some(sample()));
        assert_eq!(read(&backup_path(&path)), Some(good));
    }

    #[test]
    fn legacy_session_without_tab_fields_loads_as_main() {
        let legacy = r#"{
            "version": 1,
            "tabs": [{ "id": "main", "title": "main", "files": [], "activeFile": null }],
            "activeTabId": "main",
            "patterns": [{ "base": "/d", "recursive": true, "glob": null }],
            "closed": ["/d/old.md"]
        }"#;
        let session: SessionFile = serde_json::from_str(legacy).unwrap();
        assert_eq!(session.patterns[0].tab, "main");
        assert_eq!(
            session.closed_files(),
            vec![ClosedFile {
                tab: "main".into(),
                path: PathBuf::from("/d/old.md")
            }]
        );
        // 書き込みでは旧形式のフィールドを出力しない
        assert!(!serde_json::to_string(&session)
            .unwrap()
            .contains("\"closed\""));
    }

    #[test]
    fn uses_camel_case_keys_for_the_frontend() {
        let text = serde_json::to_string(&sample()).unwrap();
        assert!(
            text.contains("activeTabId")
                && text.contains("activeFile")
                && text.contains("closedTabs")
        );
    }
}
