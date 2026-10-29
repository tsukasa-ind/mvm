mod files;
mod launch;
mod pattern;
mod scan;
mod session;
mod tabs;
mod watcher;

use files::{file_id, resolve_image, OpenedFile, Registry};
use launch::LaunchQueue;
use pattern::{is_viewable, WatchPattern};
use scan::{expand, parse_args, scan_pattern, CliOptions};
use serde::Serialize;
use session::{ClosedFile, SessionFile, SessionTab};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use tabs::Tabs;
use tauri::{AppHandle, Emitter, Manager, State};
use watcher::DirWatcher;

const DEFAULT_TAB_ID: &str = "main";

/// 2つ目以降の起動の (argv, cwd)
type Launch = (Vec<String>, PathBuf);

/// フロントが起動時の状態を受け取るまでの2つ目以降の起動。
/// single-instance のコールバックは `AppState` の登録前にも呼ばれうるため、state ではなく static に置く
static LAUNCHES: LaunchQueue<Launch> = LaunchQueue::new();

struct AppState {
    registry: Registry,
    watcher: DirWatcher,
    /// タブごとのファイル所属、監視パターン、閉じた履歴
    tabs: Mutex<Tabs>,
    /// アクティブなタブ。フロントの `save_session` で更新し、タブを指定しない起動引数の追加先に使う
    active_tab: Mutex<String>,
    session_path: PathBuf,
    /// 起動時の状態。React の StrictMode は開発時に初期化を2回実行するため、取り出さずに複製して返す
    startup: Mutex<Option<Startup>>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct OpenFilesPayload {
    files: Vec<OpenedFile>,
    /// 追加先のタブ。存在しなければフロントが作る
    tab_id: String,
    /// 先頭のファイルを選択するか。監視パターンによる自動追加では表示中のファイルを維持する
    select: bool,
}

#[derive(Serialize, Clone)]
struct FileChangedPayload {
    id: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct RestoredTab {
    id: String,
    title: String,
    file_ids: Vec<String>,
    active_file_id: Option<String>,
}

#[derive(Serialize, Clone, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Startup {
    tabs: Vec<RestoredTab>,
    active_tab_id: String,
    /// `tabs` が参照するファイル
    files: Vec<OpenedFile>,
    /// 起動引数で渡されたファイル。復元後に開いて選択する
    cli_files: Vec<OpenedFile>,
    /// `cli_files` の追加先のタブ
    cli_tab: String,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum ReadError {
    Missing,
    Failed { message: String },
}

/// ファイルをタブに加える経緯。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Origin {
    /// 起動引数・ダイアログなど明示的に開いた。タブの閉じた履歴から外す
    Explicit,
    /// 監視パターンによる自動追加。タブが閉じられた・ファイルが閉じられた後なら加えない
    Pattern,
}

impl AppState {
    /// ファイルをタブに加えて登録し、親ディレクトリを監視する。画像の asset protocol の許可は `resolve_markdown_image` が画像ごとに行う。
    /// タブの所属の変更・登録・監視を `tabs` のロック内で行い、同時の登録や `close_file` / `close_tab` と直列化する。
    /// `Origin::Pattern` で、加える対象でなくなっていれば None。
    fn register(&self, path: &Path, tab: &str, origin: Origin) -> Option<OpenedFile> {
        let mut tabs = self.tabs.lock().unwrap();
        match origin {
            Origin::Explicit => tabs.add_member(tab, path),
            Origin::Pattern => {
                if !tabs.add_pending(tab, path) {
                    return None;
                }
            }
        }
        Some(
            self.registry
                .insert_with(path, || match self.watcher.watch_file(path) {
                    Ok(()) => true,
                    Err(err) => {
                        eprintln!("watch failed: {}: {err}", path.display());
                        false
                    }
                }),
        )
    }

    fn register_all(&self, paths: Vec<PathBuf>, tab: &str) -> Vec<OpenedFile> {
        paths
            .iter()
            .filter_map(|path| self.register(path, tab, Origin::Explicit))
            .collect()
    }

    /// パターンを `tab` のものとして登録する。新しいパターンだけ監視を始め、監視に失敗したものは登録しない
    /// (タブを閉じたときの `unwatch_dir` と対にするため)。
    fn add_patterns(&self, patterns: Vec<WatchPattern>, tab: &str) {
        let mut tabs = self.tabs.lock().unwrap();
        for pattern in patterns {
            let result = tabs.add_pattern_with(tab, pattern, |pattern| {
                self.watcher
                    .watch_dir(&pattern.base, pattern.recursive)
                    .map_err(|err| format!("{}: {err}", pattern.base.display()))
            });
            if let Err(err) = result {
                eprintln!("watch failed: {err}");
            }
        }
    }

    /// 登録と監視を解除する。監視に失敗していたファイルは、他の用途の参照数を減らさないよう unwatch しない。
    fn release(&self, id: &str) {
        if let Some(removed) = self.registry.remove(id) {
            if removed.watched {
                self.watcher.unwatch_file(&removed.path);
            }
        }
    }

    /// `tab_id` からファイルを外す。どのタブも持たなくなったときだけ、登録と監視を解除する。
    fn close_file(&self, tab_id: &str, id: &str) {
        let Some(path) = self.registry.get(id) else {
            return;
        };
        let mut tabs = self.tabs.lock().unwrap();
        if tabs.close_file(tab_id, &path) {
            self.release(id);
        }
    }

    /// タブを閉じる。タブの監視パターンと閉じた履歴を消し、どのタブも持たなくなったファイルを解除する。
    fn close_tab(&self, tab_id: &str) {
        let mut tabs = self.tabs.lock().unwrap();
        let (patterns, released) = tabs.close_tab(tab_id);
        for pattern in patterns {
            self.watcher.unwatch_dir(&pattern.base);
        }
        for path in released {
            self.release(&file_id(&path));
        }
    }
}

/// ファイル変更の通知と、監視パターンに一致する新規ファイルの、パターンを登録したタブへの自動追加。
fn on_fs_event(app: &AppHandle, paths: Vec<PathBuf>) {
    let state = app.state::<AppState>();
    for id in state
        .registry
        .ids_for_paths(paths.iter().map(PathBuf::as_path))
    {
        let _ = app.emit("file-changed", FileChangedPayload { id });
    }

    let existing: Vec<PathBuf> = paths.into_iter().filter(|path| path.is_file()).collect();
    let additions = state.tabs.lock().unwrap().pending_additions(&existing);
    let mut by_tab: Vec<(String, Vec<PathBuf>)> = Vec::new();
    for (tab, path) in additions {
        match by_tab.iter_mut().find(|(owner, _)| *owner == tab) {
            Some((_, group)) => group.push(path),
            None => by_tab.push((tab, vec![path])),
        }
    }
    for (tab, group) in by_tab {
        // 判定の後にタブやファイルが閉じられたものは加えない (タブを復活させない)
        let files: Vec<OpenedFile> = group
            .iter()
            .filter_map(|path| state.register(path, &tab, Origin::Pattern))
            .collect();
        if files.is_empty() {
            continue;
        }
        let _ = app.emit(
            "open-files",
            OpenFilesPayload {
                files,
                tab_id: tab,
                select: false,
            },
        );
    }
}

/// 保存済みセッション、監視パターンの再走査、起動引数から起動時の状態を組み立てる。
fn build_startup(state: &AppState, args: &[String], cwd: &Path) -> Startup {
    let mut files: Vec<OpenedFile> = Vec::new();
    let mut tabs: Vec<RestoredTab> = Vec::new();
    let mut active_tab_id = DEFAULT_TAB_ID.to_string();

    if let Some(saved) = session::load(&state.session_path) {
        state.tabs.lock().unwrap().restore_closed(
            saved
                .closed_files()
                .into_iter()
                .map(|closed| (closed.tab, closed.path)),
        );
        for pattern in saved.patterns {
            let tab = pattern.tab.clone();
            state.add_patterns(vec![pattern], &tab);
        }
        active_tab_id = saved.active_tab_id;
        for tab in saved.tabs {
            let mut file_ids = Vec::new();
            for path in tab.files.iter().filter(|path| path.is_file()) {
                let Some(file) = state.register(path, &tab.id, Origin::Explicit) else {
                    continue;
                };
                file_ids.push(file.id.clone());
                files.push(file);
            }
            tabs.push(RestoredTab {
                id: tab.id,
                title: tab.title,
                file_ids,
                active_file_id: tab
                    .active_file
                    .filter(|path| path.is_file())
                    .map(|path| file_id(&path)),
            });
        }
    }
    if !tabs.iter().any(|tab| tab.id == active_tab_id) {
        if tabs.is_empty() {
            tabs.push(RestoredTab {
                id: DEFAULT_TAB_ID.to_string(),
                title: DEFAULT_TAB_ID.to_string(),
                file_ids: Vec::new(),
                active_file_id: None,
            });
        }
        active_tab_id = tabs[0].id.clone();
    }
    *state.active_tab.lock().unwrap() = active_tab_id.clone();

    // 前回終了後に監視パターンへ追加されたファイルを、パターンを登録したタブへ加える
    let patterns = state.tabs.lock().unwrap().patterns();
    for pattern in patterns {
        for path in scan_pattern(&pattern) {
            let Some(file) = state.register(&path, &pattern.tab, Origin::Pattern) else {
                continue;
            };
            let index = match tabs.iter().position(|tab| tab.id == pattern.tab) {
                Some(index) => index,
                None => {
                    tabs.push(RestoredTab {
                        id: pattern.tab.clone(),
                        title: pattern.tab.clone(),
                        file_ids: Vec::new(),
                        active_file_id: None,
                    });
                    tabs.len() - 1
                }
            };
            tabs[index].file_ids.push(file.id.clone());
            files.push(file);
        }
    }

    let parsed = parse_args(args);
    let cli_tab = parsed.tab.clone().unwrap_or_else(|| active_tab_id.clone());
    let expansion = expand(&parsed.targets, cwd, parsed.options);
    let cli_files = state.register_all(expansion.files, &cli_tab);
    if parsed.options.watch {
        state.add_patterns(expansion.patterns, &cli_tab);
    }

    Startup {
        tabs,
        active_tab_id,
        files,
        cli_files,
        cli_tab,
    }
}

/// 2つ目以降の起動を処理する。表示するもの (ファイルか、指定されたタブ) がなければ None。
fn process_launch(state: &AppState, argv: &[String], cwd: &Path) -> Option<OpenFilesPayload> {
    let parsed = parse_args(argv);
    let tab = parsed
        .tab
        .clone()
        .unwrap_or_else(|| state.active_tab.lock().unwrap().clone());
    let expansion = expand(&parsed.targets, cwd, parsed.options);
    let files = state.register_all(expansion.files, &tab);
    if parsed.options.watch {
        state.add_patterns(expansion.patterns, &tab);
    }
    // タブを指定した起動は、ファイルがなくてもそのタブを作って選択する
    (!files.is_empty() || parsed.tab.is_some()).then_some(OpenFilesPayload {
        files,
        tab_id: tab,
        select: true,
    })
}

/// フロントが起動時の状態を受け取る前に届いた起動を、起動時の状態に合流させる。
/// 起動引数でファイルもタブも指定していなければ、最初の起動を起動引数として扱う (フロントが選択する)。
/// 起動引数の追加先と同じタブへの起動はそのファイルに加え、別のタブへの起動は復元するタブに加える。
fn merge_launch(startup: &mut Startup, launch: OpenFilesPayload) {
    let cli_requested = !startup.cli_files.is_empty() || startup.cli_tab != startup.active_tab_id;
    if !cli_requested {
        startup.cli_tab = launch.tab_id.clone();
    }
    if launch.tab_id == startup.cli_tab {
        for file in launch.files {
            if !startup.cli_files.iter().any(|known| known.id == file.id) {
                startup.cli_files.push(file);
            }
        }
        return;
    }
    let index = match startup.tabs.iter().position(|tab| tab.id == launch.tab_id) {
        Some(index) => index,
        None => {
            startup.tabs.push(RestoredTab {
                id: launch.tab_id.clone(),
                title: launch.tab_id.clone(),
                file_ids: Vec::new(),
                active_file_id: None,
            });
            startup.tabs.len() - 1
        }
    };
    let tab = &mut startup.tabs[index];
    if let Some(first) = launch.files.first() {
        tab.active_file_id = Some(first.id.clone());
    }
    for file in launch.files {
        if !tab.file_ids.contains(&file.id) {
            tab.file_ids.push(file.id.clone());
        }
        if !startup.files.iter().any(|known| known.id == file.id) {
            startup.files.push(file);
        }
    }
}

/// 起動時の状態を返し、保留していた起動を合流させる。以後の起動は `open-files` で通知する。
/// setup は commands より先に main スレッドで完了するため、`startup` が None になるのは異常時のみ。
fn take_startup(state: &AppState, launches: &LaunchQueue<Launch>) -> Startup {
    let mut startup = state.startup.lock().unwrap();
    let Some(startup) = startup.as_mut() else {
        return Startup::default();
    };
    launches.drain_into(|pending| {
        for (argv, cwd) in pending {
            if let Some(launch) = process_launch(state, &argv, &cwd) {
                merge_launch(startup, launch);
            }
        }
    });
    startup.clone()
}

#[tauri::command]
fn get_startup(state: State<'_, AppState>) -> Startup {
    take_startup(&state, &LAUNCHES)
}

/// ドラッグ&ドロップ、ダイアログ、相対リンクで開くパスを登録する。
/// `base_dir` 基準で解決し、ディレクトリは Markdown ファイルに展開する。存在しないものは除外する。
#[tauri::command]
fn open_paths(
    app: AppHandle,
    base_dir: String,
    paths: Vec<String>,
    recursive: bool,
    tab_id: String,
) -> Vec<OpenedFile> {
    let base = Path::new(&base_dir);
    let mut resolved: Vec<PathBuf> = Vec::new();
    for path in &paths {
        // glob は解釈しない。Markdown 内の相対リンクが `*` を含んでも、基準外のファイルを開かないため
        let expanded = match base.join(path).canonicalize() {
            Ok(target) if target.is_file() => {
                if is_viewable(&target) {
                    vec![target]
                } else {
                    Vec::new()
                }
            }
            Ok(target) if target.is_dir() => {
                expand(
                    &[target.to_string_lossy().into_owned()],
                    base,
                    CliOptions {
                        recursive,
                        watch: false,
                    },
                )
                .files
            }
            _ => Vec::new(),
        };
        for file in expanded {
            if !resolved.contains(&file) {
                resolved.push(file);
            }
        }
    }
    app.state::<AppState>().register_all(resolved, &tab_id)
}

#[tauri::command]
fn read_markdown(state: State<'_, AppState>, id: String) -> Result<String, ReadError> {
    let path = state.registry.get(&id).ok_or(ReadError::Missing)?;
    std::fs::read_to_string(&path).map_err(|err| match err.kind() {
        std::io::ErrorKind::NotFound => ReadError::Missing,
        _ => ReadError::Failed {
            message: err.to_string(),
        },
    })
}

/// ファイル `id` の Markdown 内の画像参照を絶対パスに解決し、そのファイルだけ asset protocol で表示できるようにする。
/// 開いたファイルのディレクトリ外を `../` で参照する画像のため。
#[tauri::command]
fn resolve_markdown_image(app: AppHandle, id: String, reference: String) -> Option<String> {
    let path = app.state::<AppState>().registry.get(&id)?;
    let image = resolve_image(&reference, path.parent()?)?;
    if let Err(err) = app.asset_protocol_scope().allow_file(&image) {
        eprintln!("asset scope failed: {}: {err}", image.display());
        return None;
    }
    Some(image.to_string_lossy().into_owned())
}

/// Excel などバイナリのファイルを、そのままのバイト列で返す (JSON の数値配列にしない)。
#[tauri::command]
fn read_bytes(state: State<'_, AppState>, id: String) -> Result<tauri::ipc::Response, ReadError> {
    let path = state.registry.get(&id).ok_or(ReadError::Missing)?;
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|err| match err.kind() {
            std::io::ErrorKind::NotFound => ReadError::Missing,
            _ => ReadError::Failed {
                message: err.to_string(),
            },
        })
}

/// `tab_id` からファイルを外す。どのタブも持たなくなったときだけ、登録と監視を解除する。
#[tauri::command]
fn close_file(state: State<'_, AppState>, tab_id: String, id: String) {
    state.close_file(&tab_id, &id);
}

/// タブを閉じる。タブの監視パターンと閉じた履歴を消し、どのタブも持たなくなったファイルを解除する。
#[tauri::command]
fn close_tab(state: State<'_, AppState>, tab_id: String) {
    state.close_tab(&tab_id);
}

#[tauri::command]
fn save_session(
    state: State<'_, AppState>,
    tabs: Vec<SessionTab>,
    active_tab_id: String,
) -> Result<(), String> {
    *state.active_tab.lock().unwrap() = active_tab_id.clone();
    let (patterns, closed) = {
        let owner = state.tabs.lock().unwrap();
        let closed: Vec<ClosedFile> = owner
            .closed()
            .into_iter()
            .map(|(tab, path)| ClosedFile { tab, path })
            .collect();
        (owner.patterns(), closed)
    };
    let session = SessionFile::new(tabs, active_tab_id, patterns, closed);
    session::save(&state.session_path, &session).map_err(|err| err.to_string())
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // single-instance は他のプラグインより先に登録する必要がある
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // AppState の登録前・フロントの準備前に届いた起動は積んでおき、get_startup で合流させる
            if let Some((argv, cwd)) = LAUNCHES.push_or_pass((argv, PathBuf::from(cwd))) {
                // 準備完了は AppState の登録後なので、ここで None になることはない
                if let Some(state) = app.try_state::<AppState>() {
                    if let Some(payload) = process_launch(&state, &argv, &cwd) {
                        let _ = app.emit("open-files", payload);
                    }
                }
            }
            focus_main_window(app);
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // デバウンサのスレッドで重い処理をしないよう、イベントは別スレッドへ渡す
            let (sender, receiver) = mpsc::channel::<Vec<PathBuf>>();
            let watcher = DirWatcher::new(move |paths| {
                let _ = sender.send(paths);
            })?;
            let session_path = app.path().app_data_dir()?.join("session.json");
            app.manage(AppState {
                registry: Registry::default(),
                watcher,
                tabs: Mutex::new(Tabs::default()),
                active_tab: Mutex::new(DEFAULT_TAB_ID.to_string()),
                session_path,
                startup: Mutex::new(None),
            });

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                for paths in receiver {
                    on_fs_event(&handle, paths);
                }
            });

            let args: Vec<String> = std::env::args_os()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            let cwd = std::env::current_dir()?;
            let state = app.state::<AppState>();
            let startup = build_startup(&state, &args, &cwd);
            *state.startup.lock().unwrap() = Some(startup);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_startup,
            open_paths,
            read_markdown,
            read_bytes,
            resolve_markdown_image,
            close_file,
            close_tab,
            save_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running mvm");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn app_state(dir: &Path) -> AppState {
        AppState {
            registry: Registry::default(),
            watcher: DirWatcher::new(|_| {}).unwrap(),
            tabs: Mutex::new(Tabs::default()),
            active_tab: Mutex::new(DEFAULT_TAB_ID.to_string()),
            session_path: dir.join("session.json"),
            startup: Mutex::new(None),
        }
    }

    /// 正規化済みの一時ディレクトリと、その中の Markdown ファイル
    fn fixture(names: &[&str]) -> (tempfile::TempDir, PathBuf, Vec<PathBuf>) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let files = names
            .iter()
            .map(|name| {
                let path = root.join(name);
                fs::write(&path, "# x").unwrap();
                path
            })
            .collect();
        (dir, root, files)
    }

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    fn opened(name: &str) -> OpenedFile {
        files::opened_file(Path::new(&format!("/d/{name}")))
    }

    #[test]
    fn registering_the_same_file_twice_watches_once() {
        let (_dir, root, files) = fixture(&["a.md"]);
        let state = app_state(&root);
        let first = state.register(&files[0], "a", Origin::Explicit).unwrap();
        let second = state.register(&files[0], "b", Origin::Explicit).unwrap();
        assert_eq!(first, second);
        assert_eq!(state.watcher.entry(&root), Some((1, false)));
        state.close_file("a", &first.id);
        assert_eq!(state.watcher.entry(&root), Some((1, false)));
        state.close_file("b", &first.id);
        assert_eq!(state.watcher.entry(&root), None);
        assert_eq!(state.registry.get(&first.id), None);
    }

    #[test]
    fn pattern_addition_after_closing_the_tab_is_dropped() {
        let (_dir, root, files) = fixture(&["new.md"]);
        let state = app_state(&root);
        state.add_patterns(
            vec![WatchPattern {
                base: root.clone(),
                recursive: false,
                glob: None,
                tab: String::new(),
            }],
            "spec",
        );
        assert_eq!(state.watcher.entry(&root), Some((1, false)));
        let pending = state.tabs.lock().unwrap().pending_additions(&files);
        assert_eq!(pending.len(), 1);
        // 判定の後、登録の前にタブが閉じられた
        state.close_tab("spec");
        assert_eq!(state.register(&files[0], "spec", Origin::Pattern), None);
        assert!(!state.registry.contains_path(&files[0]));
        assert_eq!(state.watcher.entry(&root), None);
    }

    #[test]
    fn pattern_that_cannot_be_watched_is_not_registered() {
        let (_dir, root, files) = fixture(&["a.md"]);
        let state = app_state(&root);
        state.register(&files[0], "main", Origin::Explicit);
        state.add_patterns(
            vec![WatchPattern {
                base: root.join("missing"),
                recursive: true,
                glob: None,
                tab: String::new(),
            }],
            "main",
        );
        assert!(state.tabs.lock().unwrap().patterns().is_empty());
        // タブを閉じても、ファイルの監視の参照数以上には解除しない
        state.close_tab("main");
        assert_eq!(state.watcher.entry(&root), None);
    }

    #[test]
    fn launch_opens_files_or_selects_the_named_tab() {
        let (_dir, root, files) = fixture(&["a.md"]);
        let state = app_state(&root);
        let launch = process_launch(&state, &args(&["mvm", "a.md"]), &root).unwrap();
        assert_eq!(launch.tab_id, DEFAULT_TAB_ID);
        assert_eq!(launch.files, vec![files::opened_file(&files[0])]);
        let launch = process_launch(&state, &args(&["mvm", "-t", "spec"]), &root).unwrap();
        assert_eq!((launch.tab_id.as_str(), launch.files.len()), ("spec", 0));
        assert_eq!(process_launch(&state, &args(&["mvm"]), &root), None);
    }

    #[test]
    fn launches_before_get_startup_are_merged_into_startup() {
        let (_dir, root, files) = fixture(&["a.md", "b.md"]);
        let state = app_state(&root);
        let queue = LaunchQueue::new();
        // setup の完了前 (AppState の登録前を含む) に届いた起動
        assert!(queue
            .push_or_pass((args(&["mvm", "a.md"]), root.clone()))
            .is_none());
        assert!(queue
            .push_or_pass((args(&["mvm", "-t", "spec", "b.md"]), root.clone()))
            .is_none());
        *state.startup.lock().unwrap() = Some(build_startup(&state, &args(&["mvm"]), &root));

        let startup = take_startup(&state, &queue);
        assert_eq!(startup.cli_tab, DEFAULT_TAB_ID);
        assert_eq!(startup.cli_files, vec![files::opened_file(&files[0])]);
        let spec = startup.tabs.iter().find(|tab| tab.id == "spec").unwrap();
        assert_eq!(spec.file_ids, vec![file_id(&files[1])]);
        assert!(startup.files.contains(&files::opened_file(&files[1])));
        // StrictMode の2回目の取得でも同じ内容を返し、以後の起動は直接処理する
        assert_eq!(take_startup(&state, &queue), startup);
        assert!(queue
            .push_or_pass((args(&["mvm", "a.md"]), root.clone()))
            .is_some());
    }

    #[test]
    fn first_merged_launch_becomes_the_cli_request() {
        let mut startup = Startup {
            active_tab_id: "main".into(),
            cli_tab: "main".into(),
            ..Startup::default()
        };
        merge_launch(
            &mut startup,
            OpenFilesPayload {
                files: vec![opened("a.md")],
                tab_id: "spec".into(),
                select: true,
            },
        );
        assert_eq!(startup.cli_tab, "spec");
        assert_eq!(startup.cli_files, vec![opened("a.md")]);
        // 同じタブへの後続の起動は重複なく加え、別のタブへの起動は復元するタブに加える
        merge_launch(
            &mut startup,
            OpenFilesPayload {
                files: vec![opened("a.md"), opened("b.md")],
                tab_id: "spec".into(),
                select: true,
            },
        );
        merge_launch(
            &mut startup,
            OpenFilesPayload {
                files: vec![opened("c.md")],
                tab_id: "main".into(),
                select: true,
            },
        );
        assert_eq!(startup.cli_files, vec![opened("a.md"), opened("b.md")]);
        assert_eq!(
            startup.tabs,
            vec![RestoredTab {
                id: "main".into(),
                title: "main".into(),
                file_ids: vec![opened("c.md").id],
                active_file_id: Some(opened("c.md").id),
            }]
        );
        assert_eq!(startup.files, vec![opened("c.md")]);
    }
}
