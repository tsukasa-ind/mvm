mod files;
mod pattern;
mod scan;
mod session;
mod tabs;
mod watcher;

use files::{file_id, resolve_path, OpenedFile, Registry};
use pattern::WatchPattern;
use scan::{expand, parse_args, scan_pattern, CliOptions};
use serde::Serialize;
use session::{ClosedFile, SessionFile, SessionTab};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use tabs::Tabs;
use tauri::{AppHandle, Emitter, Manager, State};
use watcher::DirWatcher;

const DEFAULT_TAB_ID: &str = "main";

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

#[derive(Serialize, Clone)]
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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RestoredTab {
    id: String,
    title: String,
    file_ids: Vec<String>,
    active_file_id: Option<String>,
}

#[derive(Serialize, Clone, Default)]
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

/// ファイルを登録し、親ディレクトリの監視と asset protocol のスコープ追加を行う。
/// 明示的に開かれたものとして扱うため、`tab` の閉じた履歴からは外す。
fn register_file(app: &AppHandle, path: &Path, tab: &str) -> OpenedFile {
    let state = app.state::<AppState>();
    state.tabs.lock().unwrap().add_member(tab, path);
    if state.registry.contains_path(path) {
        return state.registry.insert(path); // 監視は登録済み。参照カウントを増やさない
    }
    let file = state.registry.insert(path);
    if let Err(err) = state.watcher.watch_file(path) {
        eprintln!("watch failed: {}: {err}", path.display());
    }
    if let Some(dir) = path.parent() {
        // 相対パス画像を表示するため、開いたファイルのディレクトリ配下だけ許可する
        if let Err(err) = app.asset_protocol_scope().allow_directory(dir, true) {
            eprintln!("asset scope failed: {}: {err}", dir.display());
        }
    }
    file
}

fn register_all(app: &AppHandle, paths: Vec<PathBuf>, tab: &str) -> Vec<OpenedFile> {
    paths
        .iter()
        .map(|path| register_file(app, path, tab))
        .collect()
}

/// パターンを `tab` のものとして登録し、新しく登録したものだけ監視を始める。
fn add_patterns(app: &AppHandle, patterns: Vec<WatchPattern>, tab: &str) {
    let state = app.state::<AppState>();
    for pattern in patterns {
        let (base, recursive) = (pattern.base.clone(), pattern.recursive);
        let added = state.tabs.lock().unwrap().add_pattern(tab, pattern);
        if !added {
            continue;
        }
        if let Err(err) = state.watcher.watch_dir(&base, recursive) {
            eprintln!("watch failed: {}: {err}", base.display());
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
        let files = register_all(app, group, &tab);
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
fn build_startup(app: &AppHandle, args: &[String], cwd: &Path) -> Startup {
    let state = app.state::<AppState>();
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
            add_patterns(app, vec![pattern], &tab);
        }
        active_tab_id = saved.active_tab_id;
        for tab in saved.tabs {
            let mut file_ids = Vec::new();
            for path in tab.files.iter().filter(|path| path.is_file()) {
                let file = register_file(app, path, &tab.id);
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
            if !state.tabs.lock().unwrap().should_add(&pattern.tab, &path) {
                continue;
            }
            let file = register_file(app, &path, &pattern.tab);
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
    let cli_files = register_all(app, expansion.files, &cli_tab);
    if parsed.options.watch {
        add_patterns(app, expansion.patterns, &cli_tab);
    }

    Startup {
        tabs,
        active_tab_id,
        files,
        cli_files,
        cli_tab,
    }
}

#[tauri::command]
fn get_startup(state: State<'_, AppState>) -> Startup {
    state.startup.lock().unwrap().clone().unwrap_or_default()
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
        // 括弧などを含む実在のファイル名を glob として解釈しないよう、先にリテラルで解決する
        let expanded = match resolve_path(path, base) {
            Some(file) => vec![file],
            None => {
                expand(
                    std::slice::from_ref(path),
                    base,
                    CliOptions {
                        recursive,
                        watch: false,
                    },
                )
                .files
            }
        };
        for file in expanded {
            if !resolved.contains(&file) {
                resolved.push(file);
            }
        }
    }
    register_all(&app, resolved, &tab_id)
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
    let Some(path) = state.registry.get(&id) else {
        return;
    };
    let released = state.tabs.lock().unwrap().close_file(&tab_id, &path);
    if released {
        state.registry.remove(&id);
        state.watcher.unwatch_file(&path);
    }
}

/// タブを閉じる。タブの監視パターンと閉じた履歴を消し、どのタブも持たなくなったファイルを解除する。
#[tauri::command]
fn close_tab(state: State<'_, AppState>, tab_id: String) {
    let (patterns, released) = state.tabs.lock().unwrap().close_tab(&tab_id);
    for pattern in patterns {
        state.watcher.unwatch_dir(&pattern.base);
    }
    for path in released {
        state.registry.remove(&file_id(&path));
        state.watcher.unwatch_file(&path);
    }
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
            let parsed = parse_args(&argv);
            let tab = parsed
                .tab
                .clone()
                .unwrap_or_else(|| app.state::<AppState>().active_tab.lock().unwrap().clone());
            let expansion = expand(&parsed.targets, Path::new(&cwd), parsed.options);
            let files = register_all(app, expansion.files, &tab);
            if parsed.options.watch {
                add_patterns(app, expansion.patterns, &tab);
            }
            // タブを指定した起動は、ファイルがなくてもそのタブを作って選択する
            if !files.is_empty() || parsed.tab.is_some() {
                let _ = app.emit(
                    "open-files",
                    OpenFilesPayload {
                        files,
                        tab_id: tab,
                        select: true,
                    },
                );
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

            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir()?;
            let startup = build_startup(app.handle(), &args, &cwd);
            *app.state::<AppState>().startup.lock().unwrap() = Some(startup);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_startup,
            open_paths,
            read_markdown,
            read_bytes,
            close_file,
            close_tab,
            save_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running mvm");
}
