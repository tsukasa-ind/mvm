import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Root as HastRoot } from "hast";
import { type Components, toJsxRuntime } from "hast-util-to-jsx-runtime";
import { type JSX, type MouseEvent, useEffect, useState } from "react";
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

type ImageProps = { fileId: FileId; reference: string; alt: string; title?: string; onZoom: (src: string) => void };

/** ローカル画像。参照先の解決と表示許可を Rust に依頼してから表示する */
const LocalImage = ({ fileId, reference, alt, title, onZoom }: ImageProps) => {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      const path = await resolveMarkdownImage(fileId, safeDecode(splitFragment(reference).path));
      // 見つからない画像は元の参照のまま表示し、壊れた画像として alt を出す
      if (!cancelled) setSrc(path === null ? reference : convertFileSrc(path));
    };
    void resolve();
    return () => {
      cancelled = true;
    };
  }, [fileId, reference]);
  if (src === null) return null;
  return <img src={src} alt={alt} title={title} onClick={() => onZoom(src)} />;
};

type Props = {
  tree: HastRoot;
  /** 表示中の Markdown ファイル。画像の相対パスの解決基準 */
  fileId: FileId;
  /** Markdown 内の相対リンクで別ファイルを開く */
  onOpenRelative: (path: string) => void;
};

type Zoom = { kind: "image"; src: string; alt: string } | { kind: "svg"; html: string };

export const MarkdownBody = ({ tree, fileId, onOpenRelative }: Props) => {
  const [zoom, setZoom] = useState<Zoom | null>(null);
  const components: Components = {
    img: ({ src, alt, title }: JSX.IntrinsicElements["img"]) => {
      if (typeof src !== "string") return null;
      const onZoom = (resolved: string) => setZoom({ kind: "image", src: resolved, alt: alt ?? "" });
      if (isRelativeReference(src)) {
        return <LocalImage fileId={fileId} reference={src} alt={alt ?? ""} title={title} onZoom={onZoom} />;
      }
      return <img src={src} alt={alt ?? ""} title={title} onClick={() => onZoom(src)} />;
    },
    a: ({ href, children }: JSX.IntrinsicElements["a"]) => {
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
    },
    [MERMAID_TAG]: ({ "data-source": source }: { "data-source"?: string }) => <MermaidDiagram source={source ?? ""} onZoom={(html) => setZoom({ kind: "svg", html })} />,
  };

  return (
    <>
      {toJsxRuntime(tree, { Fragment, jsx: jsx as never, jsxs: jsxs as never, components })}
      {zoom !== null && (
        <ZoomModal label="拡大表示" onClose={() => setZoom(null)}>
          {zoom.kind === "image" ? <img src={zoom.src} alt={zoom.alt} /> : <div dangerouslySetInnerHTML={{ __html: zoom.html }} />}
        </ZoomModal>
      )}
    </>
  );
};
