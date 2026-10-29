{
  lib,
  stdenv,
  rustPlatform,
  cargo-tauri,
  fetchPnpmDeps,
  pnpmConfigHook,
  pnpm,
  nodejs_24,
  pkg-config,
  wrapGAppsHook3,
  glib,
  glib-networking,
  gtk3,
  openssl,
  webkitgtk_4_1,
  src,
}:

let
  packageJson = builtins.fromJSON (builtins.readFile ../package.json);
in
rustPlatform.buildRustPackage (finalAttrs: {
  pname = "mvm";
  inherit (packageJson) version;
  inherit src;

  cargoLock.lockFile = ../src-tauri/Cargo.lock;

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    inherit pnpm;
    fetcherVersion = 4;
    hash = "sha256-+VR+O0kLQkaLLrnpFp3FY+7nWhTC0cjUVNPZXpetPlU=";
  };

  cargoRoot = "src-tauri";
  buildAndTestSubdir = finalAttrs.cargoRoot;

  # tauri.conf.json の beforeBuildCommand (`pnpm build`) がフロントエンドを dist/ に出力し、
  # Rust 側がそれを埋め込む。pnpm の依存は pnpmDeps からオフラインで復元する。
  nativeBuildInputs = [
    cargo-tauri.hook
    pnpmConfigHook
    pnpm
    nodejs_24
    pkg-config
    wrapGAppsHook3
  ];

  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    glib
    glib-networking
    gtk3
    openssl
    webkitgtk_4_1
  ];

  meta = {
    description = "Tauri 製のスタンドアロン Markdown ビューア";
    license = lib.licenses.mit;
    mainProgram = "mvm";
    platforms = lib.platforms.linux;
  };
})
