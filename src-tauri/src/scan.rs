//! CLI 引数の解釈と、ファイル・ディレクトリ・glob の展開。

use crate::pattern::{is_skipped_dir, is_viewable, WatchPattern, MAX_FILES_PER_EXPANSION};
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct CliOptions {
    /// ディレクトリを再帰的に展開する (`-R`)
    pub recursive: bool,
    /// 展開元を監視パターンとして登録し、新規ファイルを自動で開く (`-w`)
    pub watch: bool,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ParsedArgs {
    pub options: CliOptions,
    /// 追加先のタブ名 (`-t` / `--tab`)。指定がなければアクティブなタブ
    pub tab: Option<String>,
    pub targets: Vec<String>,
}

/// argv (先頭はプログラム名) を解釈する。未知のフラグは無視する (GTK 等が付与するものを拒否しないため)。
pub fn parse_args(args: &[String]) -> ParsedArgs {
    let mut parsed = ParsedArgs::default();
    let mut rest = args.iter().skip(1);
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "-R" | "--recursive" => parsed.options.recursive = true,
            "-w" | "--watch" => parsed.options.watch = true,
            "-t" | "--tab" => parsed.tab = rest.next().cloned().filter(|name| !name.is_empty()),
            flag if flag.starts_with("--tab=") => {
                parsed.tab =
                    Some(flag["--tab=".len()..].to_string()).filter(|name| !name.is_empty());
            }
            flag if flag.starts_with('-') => {}
            target => parsed.targets.push(target.to_string()),
        }
    }
    parsed
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Expansion {
    pub files: Vec<PathBuf>,
    pub patterns: Vec<WatchPattern>,
}

fn is_glob(target: &str) -> bool {
    target.contains(['*', '?', '['])
}

pub fn expand(targets: &[String], cwd: &Path, options: CliOptions) -> Expansion {
    let mut expansion = Expansion::default();
    for target in targets {
        let (files, pattern) = expand_target(target, cwd, options);
        for file in files {
            if !expansion.files.contains(&file) {
                expansion.files.push(file);
            }
        }
        if let Some(pattern) = pattern {
            if !expansion.patterns.contains(&pattern) {
                expansion.patterns.push(pattern);
            }
        }
    }
    expansion.files.truncate(MAX_FILES_PER_EXPANSION);
    expansion
}

fn expand_target(
    target: &str,
    cwd: &Path,
    options: CliOptions,
) -> (Vec<PathBuf>, Option<WatchPattern>) {
    if is_glob(target) {
        return expand_glob(target, cwd);
    }
    let Ok(path) = cwd.join(target).canonicalize() else {
        return (Vec::new(), None);
    };
    if path.is_file() {
        (vec![path], None)
    } else if path.is_dir() {
        let pattern = WatchPattern {
            base: path.clone(),
            recursive: options.recursive,
            glob: None,
            tab: String::new(),
        };
        (scan_pattern(&pattern), Some(pattern))
    } else {
        (Vec::new(), None)
    }
}

/// glob の固定部分 (ワイルドカードを含まない先頭のディレクトリ) を正規化し、残りを連結した絶対パターンを作る。
fn expand_glob(target: &str, cwd: &Path) -> (Vec<PathBuf>, Option<WatchPattern>) {
    let absolute = cwd.join(target);
    let mut base = PathBuf::new();
    let mut rest = PathBuf::new();
    for component in absolute.components() {
        let has_wildcard =
            matches!(component, Component::Normal(name) if is_glob(&name.to_string_lossy()));
        if has_wildcard || !rest.as_os_str().is_empty() {
            rest.push(component);
        } else {
            base.push(component);
        }
    }
    let Ok(base) = base.canonicalize() else {
        return (Vec::new(), None);
    };
    if !base.is_dir() || rest.as_os_str().is_empty() {
        return (Vec::new(), None);
    }
    let pattern_string = base.join(&rest).to_string_lossy().into_owned();
    let recursive = rest.components().count() > 1;
    let pattern = WatchPattern {
        base,
        recursive,
        glob: Some(pattern_string),
        tab: String::new(),
    };
    (scan_pattern(&pattern), Some(pattern))
}

/// パターンに一致する既存ファイルを、パス順で列挙する。
pub fn scan_pattern(pattern: &WatchPattern) -> Vec<PathBuf> {
    let mut found = Vec::new();
    walk(&pattern.base, pattern.recursive, &mut found);
    found.retain(|path| pattern.matches(path));
    found.sort();
    found.truncate(MAX_FILES_PER_EXPANSION);
    found
}

fn walk(dir: &Path, recursive: bool, found: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            if recursive && !is_skipped_dir(&entry.file_name().to_string_lossy()) {
                walk(&path, recursive, found);
            }
        } else if (file_type.is_file() || file_type.is_symlink())
            && path.is_file()
            && is_viewable(&path)
        {
            found.push(path);
        }
        if found.len() >= MAX_FILES_PER_EXPANSION * 4 {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn tree() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        fs::create_dir_all(root.join("sub/deep")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::create_dir_all(root.join("node_modules/x")).unwrap();
        for file in [
            "a.md",
            "b.txt",
            "sub/c.md",
            "sub/deep/d.markdown",
            ".hidden/e.md",
            "node_modules/x/f.md",
        ] {
            fs::write(root.join(file), "# x").unwrap();
        }
        (dir, root)
    }

    #[test]
    fn parse_args_reads_flags_and_ignores_unknown() {
        let parsed = parse_args(&args(&[
            "mvm",
            "-R",
            "--watch",
            "--gapplication-x",
            "docs",
            "a.md",
        ]));
        assert_eq!(
            parsed.options,
            CliOptions {
                recursive: true,
                watch: true
            }
        );
        assert_eq!(parsed.targets, vec!["docs", "a.md"]);
        assert_eq!(parsed.tab, None);
    }

    #[test]
    fn parse_args_reads_the_tab_name_in_every_form() {
        for argv in [
            ["mvm", "-t", "spec", "a.md"],
            ["mvm", "--tab", "spec", "a.md"],
            ["mvm", "--tab=spec", "a.md", ""],
        ] {
            let argv: Vec<&str> = argv.into_iter().filter(|arg| !arg.is_empty()).collect();
            let parsed = parse_args(&args(&argv));
            assert_eq!(parsed.tab.as_deref(), Some("spec"), "{argv:?}");
            assert_eq!(parsed.targets, vec!["a.md"], "{argv:?}");
        }
        // 値のない --tab と空の名前は、指定なしとして扱う
        assert_eq!(parse_args(&args(&["mvm", "a.md", "--tab"])).tab, None);
        assert_eq!(parse_args(&args(&["mvm", "--tab=", "a.md"])).tab, None);
    }

    #[test]
    fn directory_is_expanded_non_recursively_by_default() {
        let (_dir, root) = tree();
        let expansion = expand(&args(&["."]), &root, CliOptions::default());
        assert_eq!(expansion.files, vec![root.join("a.md")]);
        assert_eq!(expansion.patterns.len(), 1);
    }

    #[test]
    fn recursive_directory_skips_hidden_and_vendor_dirs() {
        let (_dir, root) = tree();
        let expansion = expand(
            &args(&["."]),
            &root,
            CliOptions {
                recursive: true,
                watch: false,
            },
        );
        assert_eq!(
            expansion.files,
            vec![
                root.join("a.md"),
                root.join("sub/c.md"),
                root.join("sub/deep/d.markdown")
            ]
        );
    }

    #[test]
    fn glob_is_expanded_relative_to_cwd() {
        let (_dir, root) = tree();
        let single = expand(&args(&["*.md"]), &root, CliOptions::default());
        assert_eq!(single.files, vec![root.join("a.md")]);
        assert!(!single.patterns[0].recursive);

        let deep = expand(&args(&["sub/**/*.md"]), &root, CliOptions::default());
        assert_eq!(deep.files, vec![root.join("sub/c.md")]);
        assert!(deep.patterns[0].recursive);
        assert_eq!(deep.patterns[0].base, root.join("sub"));
    }

    #[test]
    fn files_are_deduplicated_and_missing_targets_ignored() {
        let (_dir, root) = tree();
        let expansion = expand(
            &args(&["a.md", "./a.md", "missing.md", "b.txt"]),
            &root,
            CliOptions::default(),
        );
        assert_eq!(expansion.files, vec![root.join("a.md"), root.join("b.txt")]);
        assert!(expansion.patterns.is_empty());
    }

    #[test]
    fn scan_finds_files_for_restored_pattern() {
        let (_dir, root) = tree();
        let pattern = WatchPattern {
            base: root.clone(),
            recursive: true,
            glob: None,
            tab: String::new(),
        };
        assert_eq!(scan_pattern(&pattern).len(), 3);
    }
}
