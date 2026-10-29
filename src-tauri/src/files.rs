//! 開いたファイルの登録。

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// フロントの `OpenedFile` と対応する。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OpenedFile {
    pub id: String,
    pub path: String,
    pub name: String,
}

/// 絶対パスの SHA-256 先頭8桁。再起動後も同じ値になる。
pub fn file_id(path: &Path) -> String {
    let digest = Sha256::digest(path.to_string_lossy().as_bytes());
    digest.iter().take(4).map(|b| format!("{b:02x}")).collect()
}

pub fn opened_file(path: &Path) -> OpenedFile {
    OpenedFile {
        id: file_id(path),
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

/// `base` 基準でパスを解決し、存在する通常ファイルの正規化済み絶対パスを返す。
pub fn resolve_path(arg: &str, base: &Path) -> Option<PathBuf> {
    let canonical = base.join(arg).canonicalize().ok()?; // 絶対パスなら arg がそのまま採用される
    canonical.is_file().then_some(canonical)
}

const IMAGE_EXTENSIONS: [&str; 9] = [
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
];

/// Markdown 内の画像の相対参照を、Markdown のあるディレクトリ `base` 基準で解決する。
/// 任意ファイルを表示対象にしないよう、画像の拡張子に限る。
pub fn resolve_image(reference: &str, base: &Path) -> Option<PathBuf> {
    if Path::new(reference).is_absolute() {
        return None;
    }
    let resolved = resolve_path(reference, base)?;
    // symlink の参照先 (`x.png -> /etc/passwd` など) を通さないよう、正規化後のパスで拡張子を検査する
    let extension = resolved.extension()?.to_string_lossy().to_lowercase();
    IMAGE_EXTENSIONS
        .contains(&extension.as_str())
        .then_some(resolved)
}

/// id と実パスの対応表。フロントは id だけを渡し、任意パスの読み取りはできない。
#[derive(Default)]
pub struct Registry {
    files: Mutex<HashMap<String, Entry>>,
}

struct Entry {
    path: PathBuf,
    /// 親ディレクトリの監視に成功したか。解除するときに参照数を対にするため
    watched: bool,
}

/// `Registry::remove` で外したファイル。
#[derive(Debug, PartialEq, Eq)]
pub struct Removed {
    pub path: PathBuf,
    pub watched: bool,
}

impl Registry {
    /// 未登録のときだけ `watch` を呼んで登録する。判定と登録を同じロック内で行い、二重に監視しない。
    pub fn insert_with(&self, path: &Path, watch: impl FnOnce() -> bool) -> OpenedFile {
        let file = opened_file(path);
        let mut files = self.files.lock().unwrap();
        if files.get(&file.id).is_some_and(|entry| entry.path == path) {
            return file; // 監視は登録済み。参照カウントを増やさない
        }
        let watched = watch();
        files.insert(
            file.id.clone(),
            Entry {
                path: path.to_path_buf(),
                watched,
            },
        );
        file
    }

    pub fn get(&self, id: &str) -> Option<PathBuf> {
        self.files
            .lock()
            .unwrap()
            .get(id)
            .map(|entry| entry.path.clone())
    }

    pub fn remove(&self, id: &str) -> Option<Removed> {
        self.files.lock().unwrap().remove(id).map(|entry| Removed {
            path: entry.path,
            watched: entry.watched,
        })
    }

    #[cfg(test)]
    pub fn contains_path(&self, path: &Path) -> bool {
        self.files
            .lock()
            .unwrap()
            .values()
            .any(|entry| entry.path == path)
    }

    /// 登録済みパスと一致する id を返す。
    pub fn ids_for_paths<'a>(&self, paths: impl IntoIterator<Item = &'a Path>) -> Vec<String> {
        let files = self.files.lock().unwrap();
        let mut ids: Vec<String> = Vec::new();
        for path in paths {
            if let Some((id, _)) = files.iter().find(|(_, entry)| entry.path == path) {
                if !ids.contains(id) {
                    ids.push(id.clone());
                }
            }
        }
        ids
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn file_id_is_stable_8_hex_digits() {
        let id = file_id(Path::new("/tmp/a.md"));
        assert_eq!(id.len(), 8);
        assert_eq!(id, file_id(Path::new("/tmp/a.md")));
        assert_ne!(id, file_id(Path::new("/tmp/b.md")));
    }

    #[test]
    fn resolve_path_handles_relative_absolute_and_directories() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        fs::create_dir(base.join("sub")).unwrap();
        fs::write(base.join("a.md"), "x").unwrap();
        fs::write(base.join("sub").join("b.md"), "x").unwrap();

        assert_eq!(resolve_path("a.md", &base), Some(base.join("a.md")));
        assert_eq!(
            resolve_path("sub/../sub/b.md", &base),
            Some(base.join("sub/b.md"))
        );
        assert_eq!(
            resolve_path(
                &base.join("a.md").to_string_lossy(),
                Path::new("/nonexistent")
            ),
            Some(base.join("a.md"))
        );
        assert_eq!(resolve_path("missing.md", &base), None);
        assert_eq!(resolve_path("sub", &base), None);
    }

    #[test]
    fn resolve_image_resolves_relative_references_outside_base() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let manual = root.join("doc").join("manual");
        fs::create_dir_all(&manual).unwrap();
        fs::create_dir_all(root.join("doc").join("images")).unwrap();
        fs::write(root.join("doc/images/a.png"), "x").unwrap();
        fs::write(manual.join("b.png"), "x").unwrap();
        fs::write(root.join("doc/images/a.md"), "x").unwrap();

        assert_eq!(
            resolve_image("../images/a.png", &manual),
            Some(root.join("doc/images/a.png"))
        );
        assert_eq!(resolve_image("b.png", &manual), Some(manual.join("b.png")));
        assert_eq!(resolve_image("../images/missing.png", &manual), None);
        assert_eq!(resolve_image("../images/a.md", &manual), None);
        assert_eq!(
            resolve_image(&root.join("doc/images/a.png").to_string_lossy(), &manual),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_image_rejects_symlink_to_non_image() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        fs::write(root.join("secret.txt"), "x").unwrap();
        std::os::unix::fs::symlink(root.join("secret.txt"), root.join("x.png")).unwrap();
        assert_eq!(resolve_image("x.png", &root), None);
    }

    #[test]
    fn registry_maps_paths_to_ids() {
        let registry = Registry::default();
        let file = registry.insert_with(Path::new("/tmp/a.md"), || true);
        assert_eq!(registry.get(&file.id), Some(PathBuf::from("/tmp/a.md")));
        assert!(registry.contains_path(Path::new("/tmp/a.md")));
        assert!(!registry.contains_path(Path::new("/tmp/x.md")));
        assert_eq!(
            registry.ids_for_paths([Path::new("/tmp/a.md"), Path::new("/tmp/x.md")]),
            vec![file.id.clone()]
        );
        assert_eq!(
            registry.remove(&file.id),
            Some(Removed {
                path: PathBuf::from("/tmp/a.md"),
                watched: true
            })
        );
        assert!(registry.get(&file.id).is_none());
    }

    #[test]
    fn registry_watches_only_on_first_insert_and_remembers_failure() {
        let registry = Registry::default();
        let mut calls = 0;
        let file = registry.insert_with(Path::new("/tmp/a.md"), || {
            calls += 1;
            false
        });
        registry.insert_with(Path::new("/tmp/a.md"), || {
            calls += 1;
            true
        });
        assert_eq!(calls, 1);
        // 監視に失敗したファイルは、解除時に unwatch しない
        assert_eq!(registry.remove(&file.id).map(|r| r.watched), Some(false));
    }
}
