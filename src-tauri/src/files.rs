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
    let extension = Path::new(reference)
        .extension()?
        .to_string_lossy()
        .to_lowercase();
    if !IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return None;
    }
    resolve_path(reference, base)
}

/// id と実パスの対応表。フロントは id だけを渡し、任意パスの読み取りはできない。
#[derive(Default)]
pub struct Registry {
    files: Mutex<HashMap<String, PathBuf>>,
}

impl Registry {
    pub fn insert(&self, path: &Path) -> OpenedFile {
        let file = opened_file(path);
        self.files
            .lock()
            .unwrap()
            .insert(file.id.clone(), path.to_path_buf());
        file
    }

    pub fn get(&self, id: &str) -> Option<PathBuf> {
        self.files.lock().unwrap().get(id).cloned()
    }

    pub fn remove(&self, id: &str) -> Option<PathBuf> {
        self.files.lock().unwrap().remove(id)
    }

    pub fn contains_path(&self, path: &Path) -> bool {
        self.files.lock().unwrap().values().any(|p| p == path)
    }

    /// 登録済みパスと一致する id を返す。
    pub fn ids_for_paths<'a>(&self, paths: impl IntoIterator<Item = &'a Path>) -> Vec<String> {
        let files = self.files.lock().unwrap();
        let mut ids: Vec<String> = Vec::new();
        for path in paths {
            if let Some((id, _)) = files.iter().find(|(_, p)| p.as_path() == path) {
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
    }

    #[test]
    fn registry_maps_paths_to_ids() {
        let registry = Registry::default();
        let file = registry.insert(Path::new("/tmp/a.md"));
        assert_eq!(registry.get(&file.id), Some(PathBuf::from("/tmp/a.md")));
        assert!(registry.contains_path(Path::new("/tmp/a.md")));
        assert!(!registry.contains_path(Path::new("/tmp/x.md")));
        assert_eq!(
            registry.ids_for_paths([Path::new("/tmp/a.md"), Path::new("/tmp/x.md")]),
            vec![file.id.clone()]
        );
        assert!(registry.remove(&file.id).is_some());
        assert!(registry.get(&file.id).is_none());
    }
}
