# mvm

Tauri v2 で作ったスタンドアロンの Markdown ビューア。[k1LoW/mo](https://github.com/k1LoW/mo) を参考にしている。mo は HTTP サーバとブラウザで表示するが、mvm は HTTP サーバを持たず、ネイティブウィンドウ内で表示する。

## 機能

- GFM、シンタックスハイライト(Shiki)、数式(KaTeX)、GitHub Alerts、Mermaid
- 保存時の自動再読み込み(エディタの rename 保存に対応)
- ディレクトリ・glob の展開と、新規ファイルの自動追加(`-w`)
- サイドバー(ツリー/フラット表示、`Ctrl+B` で表示/非表示)、目次、ファイル名・本文の検索(`Ctrl+K`)
- 相対パス画像の表示、画像と図のクリックによる拡大
- YAML frontmatter の折りたたみ、Raw 表示、Markdown / テキスト / HTML のコピー
- 文字サイズ(4段階)と本文幅の切替、ダーク/ライトテーマ(システム設定に追従)
- ドラッグ&ドロップ、ファイル/フォルダ選択ダイアログ
- 再起動時に開いていたファイルを復元
- 起動中に `mvm` を再実行すると、既存のウィンドウにファイルを追加
- タブ(ファイルのグループ)。タブごとに監視パターンを持ち、同じファイルを複数のタブで開ける
- Excel(`.xlsx`)の表示: セルの表(値・数値書式・罫線・塗り・結合)に加えて、図形・コネクタ(矢印)・グループ・画像を SVG で描画する。シート切替、拡大縮小、ドラッグでの移動に対応

## 使い方

```sh
mvm README.md                 # ファイルを開く
mvm 業務フロー.xlsx            # Excel を開く(図形も表示する)
mvm a.md b.md                 # 複数のファイル
mvm docs/                     # ディレクトリ直下の Markdown
mvm -R docs/                  # 再帰的に展開
mvm -w -R docs/               # 展開に加え、docs 配下に作られた新規ファイルを自動で開く
mvm -t spec docs/spec.md      # タブ spec に開く(なければ作る)
mvm 'docs/**/*.md'            # glob(シェルに展開させないよう引用符で囲む)
```

| フラグ | 動作 |
|---|---|
| `-R`, `--recursive` | ディレクトリを再帰的に展開する |
| `-w`, `--watch` | 展開元(ディレクトリ・glob)を監視パターンとして登録し、一致する新規ファイルを自動で開く |
| `-t NAME`, `--tab NAME` | 開く先のタブ。なければ作成して選択する。`-w` を併用すると、そのタブにパターンを登録する。省略するとアクティブなタブ |

- ディレクトリの展開対象は `md` / `markdown` / `mdown` / `mkd` / `xlsx`(Excel の一時ファイル `~$*.xlsx` は除く)。`.` で始まるディレクトリ、`node_modules`、`target` は辿らない。1回の展開で開くのは1000ファイルまで。
- 閉じたファイルは、同じタブの監視パターンが再度開かない。別のタブのパターンには影響しない。
- セッション(開いているファイル、選択中のファイル、監視パターン)は、アプリのデータディレクトリの `session.json` に保存する。Linux では `~/.local/share/com.tsukasa-ind.mvm/session.json`。監視パターンはタブに紐づき、タブを閉じると解除される。

### タブ

- タブは、ヘッダーの「＋タブ」ボタンか `--tab` で作る。タブが2つ以上あるときだけ、タブバーを表示する。最後の1つは閉じられない。
- サイドバーでファイルを右クリックすると、「別のタブへ追加」で他のタブに同じファイルを開ける。内容と監視は共有し、スクロール位置もファイル単位で共有する。
- 監視パターンで自動追加するファイルは、パターンを登録したタブに入る(表示中のタブとは限らない)。
- タブ名の変更と、タブ間のドラッグ移動は未対応。

### キーボードショートカット

| キー | 動作 |
|---|---|
| `Ctrl+B` | サイドバーの表示/非表示 |
| `Ctrl+K` | 検索欄にフォーカス(サイドバーが非表示なら表示する) |
| `Ctrl+Tab` / `Ctrl+PageDown` | 次のタブ |
| `Ctrl+Shift+Tab` / `Ctrl+PageUp` | 前のタブ |
| `Ctrl+1` 〜 `Ctrl+9` | N 番目のタブ |
| `Esc` | 拡大表示を閉じる |

macOS では `Ctrl` の代わりに `Cmd` を使える。

## インストール(Nix)

Linux(x86_64 / aarch64)向けに flake でパッケージを提供している。

```sh
nix run .                      # ビルドして起動(引数はそのまま渡る: nix run . -- README.md)
nix profile install .          # ユーザー環境にインストール
nix build .                    # ./result/bin/mvm を作る
```

リモートの flake として使う場合は、`.` を `github:tsukasa-ind/mvm` などのフレーク参照に置き換える。

NixOS や home-manager では、flake の入力に追加して `overlays.default` を適用するか、`packages.${system}.default` を直接参照する。

```nix
{
  inputs.mvm.url = "path:/path/to/mvm"; # または github:tsukasa-ind/mvm
  # ...
  # nixpkgs.overlays = [ inputs.mvm.overlays.default ];
  # environment.systemPackages = [ pkgs.mvm ];   # overlay を適用した場合
  # environment.systemPackages = [ inputs.mvm.packages.${system}.default ];  # 直接参照する場合
}
```

- ビルドは `nix/package.nix`(`rustPlatform.buildRustPackage` + `cargo-tauri.hook` + `fetchPnpmDeps`)で行う。deb 形式でバンドルした `.desktop` とアイコンも `share/` に入る。
- ソースは flake の `self`(Git で追跡しているファイルのみ)。新しいファイルを追加したら `git add` してからビルドする。
- `pnpm-lock.yaml` を更新したら、`nix/package.nix` の `pnpmDeps.hash` を更新する。`hash = lib.fakeHash;` にしてビルドすると、エラーに正しい値(`got:`)が表示される。CI の Nix ワークフロー(`.github/workflows/nix.yml`)が `nix build .#default` を実行し、更新漏れを検出する。このワークフローは `pnpm-lock.yaml`、`pnpm-workspace.yaml`、`nix/`、`flake.nix`、`flake.lock` の変更時だけ動く。
- ビルド中に `cargo test` が実行される。

### `inputs.nixpkgs.follows` を付けない

`pnpmDeps.hash` は、pnpm の store を作った pnpm のバージョンに依存する(同じ `pnpm-lock.yaml` でも、pnpm のバージョンが違うと store の内容が変わる)。この hash は、mvm の `flake.lock` が指す nixpkgs(2026-10 時点で nixos-unstable、pnpm 12.9.0)で算出している。

利用側が `mvm.inputs.nixpkgs.follows = "nixpkgs"` で自分の nixpkgs に揃えると、pnpm のバージョンが違う場合に `hash mismatch in fixed-output derivation` でビルドが失敗する(例: nixos-26.05 の先頭は pnpm 11.27.0)。

- 推奨: `follows` を付けず、mvm の nixpkgs をそのまま使う。
- `follows` を付ける場合は、利用側で hash を差し替える。`nix flake update` で nixpkgs や mvm を更新するたびに、貼り直しが必要になる。
- 利用側の pnpm のバージョンは、`flake.lock` の `.nodes.root.inputs.nixpkgs` が指すノードの rev で確認する。`.nodes.nixpkgs` は他の input だけが参照する別ノードのことがある。
- CI の `nix build .#default` は mvm の `flake.lock` の nixpkgs でビルドするため、`follows` を付けた場合の hash のずれは検出しない。

```nix
mvm-pkg = mvm.packages.${pkgs.stdenv.hostPlatform.system}.default.overrideAttrs (old: {
  pnpmDeps = old.pnpmDeps.override { hash = "sha256-<エラーの got の値>"; };
});
```

## 開発

必要なもの: Rust、Node.js 24、pnpm、Tauri の[システム依存パッケージ](https://v2.tauri.app/start/prerequisites/)。

NixOS または Nix を使う場合は、`flake.nix` の devShell と direnv で一式が揃う。

```sh
direnv allow          # または nix develop
pnpm install
pnpm tauri dev        # 開発サーバ(Vite)付きで起動
```

### テストと検査

```sh
pnpm typecheck
pnpm test                                         # vitest
cd src-tauri && cargo test
cd src-tauri && cargo clippy --all-targets -- -D warnings
```

Rust のビルドは `dist/` を埋め込むため、事前に `pnpm build` が必要。`cargo tauri build --debug --no-bundle` は両方を実行する。

### ビルド

```sh
pnpm tauri build                  # 現在の OS 向けの配布物
pnpm tauri build --bundles deb    # 形式を指定
```

クロスビルドはできない。各 OS 向けの配布物は GitHub Actions で作る。`v*` タグを push すると `release.yml` がドラフトリリースに配布物を添付する。Windows 向けのビルドを WSL で行う場合は、WSL の UNC パス上ではなく Windows 側のファイルシステムで行う。

## 構成

| パス | 内容 |
|---|---|
| `src-tauri/src/` | Rust。ファイル登録(`files.rs`)、引数の展開(`scan.rs`)、監視パターン(`pattern.rs`)、ファイル監視(`watcher.rs`)、タブごとのファイル所属・監視パターン・閉じた履歴(`tabs.rs`)、セッション(`session.rs`)、Tauri コマンド(`lib.rs`) |
| `src/lib/pipeline.ts` | Markdown から hast への変換(unified)。Tauri に依存しない |
| `src/state/`, `src/domain/` | 状態管理(reducer)と型 |
| `src/components/` | サイドバー、目次、ビューア、ツールバー、Mermaid、ズームモーダル |

ファイルの読み取りは、フロントエンドが渡すパスではなく、Rust 側が登録した ID で行う。Tauri の `fs` プラグインは使っていない。設計の経緯と判断は [DESIGN.md](DESIGN.md) にある。

## ライセンス

[MIT](LICENSE)

## 制限

- Excel: グラフ(`.xlsx` 内のグラフ)、SmartArt、条件付き書式、セル内の部分的な書式(リッチテキスト)は表示しない。`.xls` と `.xlsm` は対象外。本文の検索は Markdown のみで、Excel はファイル名だけが対象。
- Excel の図形は、図形の種類ごとに SVG で描く。`rect`、`ellipse`、`roundRect`、`triangle`、`diamond`、フローチャートの各種、折れ線コネクタ、吹き出し(`wedgeRectCallout` / `wedgeRoundRectCallout`)など18種に対応し、未対応の種類は外接する矩形で代用して件数をツールバーに表示する。Excel と同じフォント(Meiryo UI など)がない環境では、代替フォントになり、文字の折り返し位置が変わる。

- GUI の動作確認は Linux(WebKitGTK)のみ。Windows と macOS は、CI でビルド・clippy・テストが通ることまで確認している。
- macOS で Finder からファイルを開く操作(`RunEvent::Opened`)には未対応。
- コード署名と公証は未設定。
