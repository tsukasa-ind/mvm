import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Root as HastRoot } from "hast";
import { type Components, toJsxRuntime } from "hast-util-to-jsx-runtime";
import { type JSX, type MouseEvent, createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { MermaidDiagram } from "../components/MermaidDiagram";
import { ZoomModal } from "../components/ZoomModal";
import type { FileId } from "../domain/types";
import { resolveMarkdownImage } from "./ipc";
import { MERMAID_TAG } from "./pipeline";
import { isRelativeReference, safeDecode, splitFragment } from "./path";

const EXTERNAL_PROTOCOLS = /^(https?|mailto):/i;

const scrollToFragment = (fragment: string) => {
  document.getElementById(safeDecode(fragment.slice(1)))?.scrollIntoView();
};

type Zoom = { kind: "image"; src: string; alt: string } | { kind: "svg"; html: string };

type BodyContext = {
  fileId: FileId;
  onOpenRelative: (path: string) => void;
  setZoom: (zoom: Zoom) => void;
};

// components は MarkdownBody の再描画のたびに作り直すと、React が要素の型の変化と見なして
// Mermaid や画像を再マウントする。モジュールスコープで固定し、可変の値は context で渡す。
const BodyContext = createContext<BodyContext | null>(null);

const useBody = (): BodyContext => {
  const context = useContext(BodyContext);
  if (context === null) throw new Error("MarkdownBody の外で使われた");
  return context;
};

type ImageProps = { reference: string; alt: string; title?: string };

/** ローカル画像。参照先の解決と表示許可を Rust に依頼してから表示する */
const LocalImage = ({ reference, alt, title }: ImageProps) => {
  const { fileId, setZoom } = useBody();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      try {
        const path = await resolveMarkdownImage(fileId, safeDecode(splitFragment(reference).path));
        // 見つからない画像は元の参照のまま表示し、壊れた画像として alt を出す
        if (!cancelled) setSrc(path === null ? reference : convertFileSrc(path));
      } catch {
        if (!cancelled) setSrc(reference);
      }
    };
    void resolve();
    return () => {
      cancelled = true;
    };
  }, [fileId, reference]);
  if (src === null) return null;
  return <img src={src} alt={alt} title={title} onClick={() => setZoom({ kind: "image", src, alt })} />;
};

const BodyImage = ({ src, alt, title }: JSX.IntrinsicElements["img"]) => {
  const { setZoom } = useBody();
  if (typeof src !== "string") return null;
  if (isRelativeReference(src)) return <LocalImage reference={src} alt={alt ?? ""} title={title} />;
  return <img src={src} alt={alt ?? ""} title={title} onClick={() => setZoom({ kind: "image", src, alt: alt ?? "" })} />;
};

const BodyLink = ({ href, children }: JSX.IntrinsicElements["a"]) => {
  const { onOpenRelative } = useBody();
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // WebView 内で遷移させない
    event.preventDefault();
    if (href === undefined) return;
    if (href.startsWith("#")) scrollToFragment(href);
    else if (EXTERNAL_PROTOCOLS.test(href)) void openUrl(href);
    else if (isRelativeReference(href)) onOpenRelative(safeDecode(splitFragment(href).path));
  };
  return (
    <a href={href} onClick={onClick}>
      {children}
    </a>
  );
};

const BodyMermaid = ({ "data-source": source }: { "data-source"?: string }) => {
  const { setZoom } = useBody();
  return <MermaidDiagram source={source ?? ""} onZoom={(html) => setZoom({ kind: "svg", html })} />;
};

const components: Components = { img: BodyImage, a: BodyLink, [MERMAID_TAG]: BodyMermaid };

type Props = {
  tree: HastRoot;
  /** 表示中の Markdown ファイル。画像の相対パスの解決基準 */
  fileId: FileId;
  /** Markdown 内の相対リンクで別ファイルを開く */
  onOpenRelative: (path: string) => void;
};

export const MarkdownBody = ({ tree, fileId, onOpenRelative }: Props) => {
  const [zoom, setZoom] = useState<Zoom | null>(null);
  // onOpenRelative は親の再描画のたびに作り直されるため、ref 経由にして context の値を安定させる
  const openRelative = useRef(onOpenRelative);
  openRelative.current = onOpenRelative;
  const context = useMemo<BodyContext>(() => ({ fileId, onOpenRelative: (path) => openRelative.current(path), setZoom }), [fileId]);
  // tree が変わらない限り、変換結果の React 要素を作り直さない
  const content = useMemo(() => toJsxRuntime(tree, { Fragment, jsx: jsx as never, jsxs: jsxs as never, components }), [tree]);

  return (
    <BodyContext.Provider value={context}>
      {content}
      {zoom !== null && (
        <ZoomModal label="拡大表示" onClose={() => setZoom(null)}>
          {zoom.kind === "image" ? <img src={zoom.src} alt={zoom.alt} /> : <div dangerouslySetInnerHTML={{ __html: zoom.html }} />}
        </ZoomModal>
      )}
    </BodyContext.Provider>
  );
};
