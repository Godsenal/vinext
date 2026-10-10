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
  getDocumentHeadCloseMarker,
  getDocumentHeadOpenMarker,
  getDocumentMainPlaceholder,
  getDocumentScriptsPlaceholder,
} from "vinext/shims/document-placeholders";

function spliceAt(html: string, start: number, end: number, insertion: string): string {
  return html.slice(0, start) + insertion + html.slice(end);
}

/**
 * Insert `insertion` right after `<Head>`'s opening tag and drop its marker.
 * The marker is the tag's last attribute, so the tag ends where it does.
 */
export function spliceDocumentHeadOpen(html: string, token: string, insertion: string): string {
  const marker = getDocumentHeadOpenMarker(token);
  const index = html.indexOf(marker);
  if (index === -1) return html;
  return spliceAt(html, index, index + marker.length, `>${insertion}`);
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
 * Outside production, warn about a Document that left out `<Main />`,
 * `<Head>` or `<NextScript />`, with Next.js's message. Call it on the
 * rendered Document before any marker is spliced out.
 */
export function warnMissingDocumentComponents(html: string, token: string): void {
  if (process.env.NODE_ENV === "production") return;
  const missing = [
    html.includes(getDocumentMainPlaceholder(token)) ? null : "Main",
    html.includes(getDocumentHeadOpenMarker(token)) ? null : "Head",
    html.includes(getDocumentScriptsPlaceholder(token)) ? null : "NextScript",
  ].filter((name) => name !== null);
  if (missing.length === 0) return;
  const plural = missing.length !== 1 ? "s" : "";
  console.warn(
    `Your custom Document (pages/_document) did not render all the required subcomponent${plural}.\n` +
      `Missing component${plural}: ${missing.map((name) => `<${name} />`).join(", ")}\n` +
      "Read how to fix here: https://nextjs.org/docs/messages/missing-document-component",
  );
}
