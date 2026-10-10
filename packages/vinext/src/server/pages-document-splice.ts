/**
 * Splices framework output into a serialized custom Pages Router Document.
 *
 * `<Head>`, `<Main />` and `<NextScript />` mark their splice points with the
 * per-render token from `vinext/shims/document-placeholders`, so nothing the
 * Document renders can be taken for one. Every edit slices at a located index
 * rather than calling `String#replace`, so inserted HTML is never parsed for
 * `$&`-style replacement patterns. Like Next.js, a Document that leaves out
 * one of those components gets nothing inserted for it: the Document is never
 * searched for tags.
 */
import {
  DOCUMENT_HEAD_OPEN_ATTRIBUTE,
  type DocumentComponentName,
  getDocumentHeadCloseMarker,
  getDocumentMainPlaceholder,
  getDocumentScriptsPlaceholder,
} from "vinext/shims/document-placeholders";
import { escapeRegExp } from "../utils/regex.js";

const REQUIRED_DOCUMENT_COMPONENTS: readonly DocumentComponentName[] = [
  "Main",
  "Head",
  "NextScript",
  "Html",
];

function spliceAt(html: string, start: number, end: number, insertion: string): string {
  return html.slice(0, start) + insertion + html.slice(end);
}

/**
 * Insert `insertion` right after `<Head>`'s opening tag and drop its marker
 * attribute. The attribute is matched in any quote style and position, since
 * dev HTML transforms run between rendering and this splice.
 */
export function spliceDocumentHeadOpen(html: string, token: string, insertion: string): string {
  const marker = new RegExp(
    `\\s${DOCUMENT_HEAD_OPEN_ATTRIBUTE}=(["']?)${escapeRegExp(token)}\\1(?=[\\s/>])`,
  ).exec(html);
  if (!marker) return html;
  const markerEnd = marker.index + marker[0].length;
  // React escapes `>` in attribute values, so the next one ends the tag.
  const tagEnd = html.indexOf(">", markerEnd) + 1;
  if (tagEnd === 0) return html;
  return (
    html.slice(0, marker.index) + html.slice(markerEnd, tagEnd) + insertion + html.slice(tagEnd)
  );
}

/** Replace `<Head>`'s closing marker with `insertion`. */
export function spliceDocumentHeadClose(html: string, token: string, insertion: string): string {
  const marker = getDocumentHeadCloseMarker(token);
  const index = html.indexOf(marker);
  if (index === -1) return html;
  return spliceAt(html, index, index + marker.length, insertion);
}

/** Put the generated hydration scripts where `<NextScript />` rendered. */
export function spliceDocumentScripts(html: string, token: string, scripts: string): string {
  const placeholder = getDocumentScriptsPlaceholder(token);
  const index = html.indexOf(placeholder);
  if (index === -1) return html;
  return spliceAt(html, index, index + placeholder.length, scripts);
}

/**
 * Split the Document where `<Main />` rendered. Like Next.js, a Document
 * without `<Main />` gets the page body after its own markup.
 */
export function splitDocumentAtMain(
  html: string,
  token: string,
): { prefix: string; suffix: string } {
  const placeholder = getDocumentMainPlaceholder(token);
  const index = html.indexOf(placeholder);
  if (index === -1) return { prefix: html, suffix: "" };
  return { prefix: html.slice(0, index), suffix: html.slice(index + placeholder.length) };
}

/**
 * Outside production, warn about a Document that left out a required
 * `next/document` component, with Next.js's message.
 */
export function warnMissingDocumentComponents(
  renderedComponents: ReadonlySet<DocumentComponentName>,
): void {
  if (process.env.NODE_ENV === "production") return;
  const missing = REQUIRED_DOCUMENT_COMPONENTS.filter((name) => !renderedComponents.has(name));
  if (missing.length === 0) return;
  const plural = missing.length !== 1 ? "s" : "";
  console.warn(
    `Your custom Document (pages/_document) did not render all the required subcomponent${plural}.\n` +
      `Missing component${plural}: ${missing.map((name) => `<${name} />`).join(", ")}\n` +
      "Read how to fix here: https://nextjs.org/docs/messages/missing-document-component",
  );
}
