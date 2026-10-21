//! セッション (開いているファイルとタブ) の永続化。

use crate::pattern::WatchPattern;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
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

/// ファイルが無い・壊れている・バージョン不一致のときは None (セッションなしで起動する)。
pub fn load(path: &Path) -> Option<SessionFile> {
    let text = fs::read_to_string(path).ok()?;
    let session: SessionFile = serde_json::from_str(&text).ok()?;
    (session.version == VERSION).then_some(session)
}

/// 一時ファイルへ書いてから rename し、書き込み途中の破損を避ける。
pub fn save(path: &Path, session: &SessionFile) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(session)?)?;
    fs::rename(&tmp, path)
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
