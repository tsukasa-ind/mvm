//! 監視パターン。`-w` で登録したディレクトリ・glob に一致する新規ファイルを自動で開く。

use glob::MatchOptions;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

/// ビューアで開ける拡張子 (Markdown と Excel)
pub const VIEWABLE_EXTENSIONS: [&str; 5] = ["md", "markdown", "mdown", "mkd", "xlsx"];
/// ディレクトリ走査で辿らない名前 (隠しディレクトリは別途除外する)
const SKIPPED_DIRS: [&str; 2] = ["node_modules", "target"];
/// 1回の展開で開くファイル数の上限。巨大なツリーを誤って指定したときの保護
pub const MAX_FILES_PER_EXPANSION: usize = 1000;

pub fn is_viewable(path: &Path) -> bool {
    // Excel が開いている間に作る一時ファイル (~$name.xlsx) は対象外
    if path
        .file_name()
        .is_some_and(|name| name.to_string_lossy().starts_with("~$"))
    {
        return false;
    }
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| VIEWABLE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

pub fn is_skipped_dir(name: &str) -> bool {
    name.starts_with('.') || SKIPPED_DIRS.contains(&name)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WatchPattern {
    /// 監視するディレクトリ (正規化済み絶対パス)
    pub base: PathBuf,
    pub recursive: bool,
    /// glob の場合の絶対パスパターン。None のときは `base` 配下の Markdown 全て
    pub glob: Option<String>,
    /// 登録したタブ。展開時は空で、`Tabs::add_pattern` が設定する。旧セッションは `main`
    #[serde(default = "default_tab")]
    pub tab: String,
}

fn default_tab() -> String {
    "main".to_string()
}

impl WatchPattern {
    pub fn matches(&self, path: &Path) -> bool {
        match &self.glob {
            Some(pattern) => glob::Pattern::new(pattern).is_ok_and(|pattern| {
                pattern.matches_path_with(
                    path,
                    MatchOptions {
                        case_sensitive: true,
                        require_literal_separator: true,
                        require_literal_leading_dot: true,
                    },
                )
            }),
            None => is_viewable(path) && self.is_in_scope(path),
        }
    }

    fn is_in_scope(&self, path: &Path) -> bool {
        if !self.recursive {
            return path.parent() == Some(self.base.as_path());
        }
        let Ok(relative) = path.strip_prefix(&self.base) else {
            return false;
        };
        let mut components: Vec<Component> = relative.components().collect();
        components.pop(); // ファイル名
        components.iter().all(|component| match component {
            Component::Normal(name) => !is_skipped_dir(&name.to_string_lossy()),
            _ => false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_pattern(recursive: bool) -> WatchPattern {
        WatchPattern {
            base: PathBuf::from("/docs"),
            recursive,
            glob: None,
            tab: String::new(),
        }
    }

    #[test]
    fn markdown_extension_is_case_insensitive() {
        assert!(is_viewable(Path::new("/a/B.MD")));
        assert!(is_viewable(Path::new("/a/b.markdown")));
        assert!(!is_viewable(Path::new("/a/b.md~")));
        assert!(!is_viewable(Path::new("/a/b.txt")));
        assert!(is_viewable(Path::new("/a/b.XLSX")));
        assert!(!is_viewable(Path::new("/a/~$b.xlsx")));
        assert!(!is_viewable(Path::new("/a/README")));
    }

    #[test]
    fn directory_pattern_non_recursive_matches_direct_children_only() {
        let pattern = dir_pattern(false);
        assert!(pattern.matches(Path::new("/docs/a.md")));
        assert!(!pattern.matches(Path::new("/docs/sub/a.md")));
        assert!(!pattern.matches(Path::new("/docs/a.md.tmp")));
        assert!(!pattern.matches(Path::new("/other/a.md")));
    }

    #[test]
    fn directory_pattern_recursive_skips_hidden_and_vendor_dirs() {
        let pattern = dir_pattern(true);
        assert!(pattern.matches(Path::new("/docs/sub/deep/a.md")));
        assert!(!pattern.matches(Path::new("/docs/.git/a.md")));
        assert!(!pattern.matches(Path::new("/docs/node_modules/x/a.md")));
        assert!(!pattern.matches(Path::new("/docs-other/a.md")));
    }

    #[test]
    fn glob_pattern_respects_separator_and_double_star() {
        let single = WatchPattern {
            base: PathBuf::from("/docs"),
            recursive: false,
            glob: Some("/docs/*.md".into()),
            tab: String::new(),
        };
        assert!(single.matches(Path::new("/docs/a.md")));
        assert!(!single.matches(Path::new("/docs/sub/a.md")));
        let deep = WatchPattern {
            base: PathBuf::from("/docs"),
            recursive: true,
            glob: Some("/docs/**/*.md".into()),
            tab: String::new(),
        };
        assert!(deep.matches(Path::new("/docs/sub/a.md")));
        assert!(!deep.matches(Path::new("/docs/sub/a.txt")));
    }
}
