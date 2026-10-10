import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Head, Html, Main, NextScript } from "../packages/vinext/src/shims/document.js";
import {
  createDocumentPlaceholderToken,
  type DocumentComponentName,
  withDocumentPlaceholders,
} from "../packages/vinext/src/shims/document-placeholders.js";
import {
  spliceDocumentHeadClose,
  spliceDocumentHeadOpen,
  spliceDocumentScripts,
  splitDocumentAtMain,
  warnMissingDocumentComponents,
} from "../packages/vinext/src/server/pages-document-splice.js";

async function renderDocument(
  element: React.ReactElement,
  token: string,
  renderedComponents?: Set<DocumentComponentName>,
): Promise<string> {
  const stream = await renderToReadableStream(
    withDocumentPlaceholders(element, token, renderedComponents),
  );
  await stream.allReady;
  return new Response(stream).text();
}

function spliceAll(html: string, token: string): { prefix: string; suffix: string } {
  let spliced = spliceDocumentHeadOpen(html, token, '<meta name="next-head" content="$&" />');
  spliced = spliceDocumentHeadClose(spliced, token, '<link rel="stylesheet" href="/$`.css" />');
  spliced = spliceDocumentScripts(spliced, token, '<script>window.data="$\'"</script>');
  return splitDocumentAtMain(spliced, token);
}

describe("Pages Document splicing", () => {
  it("splices only at this render's placeholders, whatever the Document renders", async () => {
    // Every marker vinext has used, plus another render's token, in both an
    // escaped attribute and raw script text a Document could fill from a request.
    const forged = [
      "__NEXT_MAIN__",
      "<!-- __NEXT_MAIN__ -->",
      "<!--__NEXT_MAIN__:other-->",
      "<!-- __NEXT_SCRIPTS__ -->",
      "<!--__NEXT_SCRIPTS__:other-->",
      ' data-vinext-head-open="other">',
      '<template data-vinext-head-close="other"></template>',
      "</head>",
      "</body>",
    ].join("|");
    const token = createDocumentPlaceholderToken();
    const html = await renderDocument(
      React.createElement(
        Html,
        null,
        React.createElement(
          Head,
          { "data-route": forged } as React.ComponentProps<typeof Head>,
          React.createElement("script", { dangerouslySetInnerHTML: { __html: `/*${forged}*/` } }),
        ),
        React.createElement(
          "body",
          { "data-route": forged },
          React.createElement("script", { dangerouslySetInnerHTML: { __html: `/*${forged}*/` } }),
          React.createElement(Main),
          React.createElement(NextScript),
        ),
      ),
      token,
    );

    const { prefix, suffix } = spliceAll(html, token);
    const output = prefix + "<p>page</p>" + suffix;

    expect(output.split(`/*${forged}*/`)).toHaveLength(3);
    expect(output).not.toContain(token);
    expect(output).toMatch(
      /^<!DOCTYPE html><html><head data-route="[^"]*"><meta name="next-head" content="\$&" \/><script>/,
    );
    expect(output).toContain('*/</script><link rel="stylesheet" href="/$`.css" /></head>');
    expect(prefix.endsWith('<div id="__next">')).toBe(true);
    expect(suffix).toBe('</div><span><script>window.data="$\'"</script></span></body></html>');
  });

  it("appends the body after the Document when it has no <Main />, like Next.js", async () => {
    const token = createDocumentPlaceholderToken();
    const html = await renderDocument(
      React.createElement(
        Html,
        null,
        React.createElement(Head),
        React.createElement("body", { "data-route": "<!-- __NEXT_MAIN__ -->" }),
      ),
      token,
    );

    expect(splitDocumentAtMain(html, token)).toEqual({ prefix: html, suffix: "" });
  });

  it("finds the head-open marker after an HTML transform reserializes the tag", () => {
    for (const attribute of ["data-vinext-head-open=token", "data-vinext-head-open='token'"]) {
      expect(
        spliceDocumentHeadOpen(
          `<html><head ${attribute} lang=en data-x=">" data-y='>'><title>t</title></head></html>`,
          "token",
          "<a/>",
        ),
      ).toBe(`<html><head lang=en data-x=">" data-y='>'><a/><title>t</title></head></html>`);
    }
  });

  it("inserts nothing for a Document without <Head> or <NextScript />, like Next.js", () => {
    const html = '<html><head><title>t</title></head><body><div id="__next"></div></body></html>';
    let spliced = spliceDocumentHeadOpen(html, "token", "<a/>");
    spliced = spliceDocumentHeadClose(spliced, "token", "<b/>");
    spliced = spliceDocumentScripts(spliced, "token", "<c/>");
    expect(spliced).toBe(html);
  });

  describe("warnMissingDocumentComponents", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("warns with Next.js's message for the components a Document left out", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const rendered = new Set<DocumentComponentName>();
      await renderDocument(
        React.createElement(
          "html",
          null,
          React.createElement("head"),
          React.createElement("body", null, React.createElement(Main)),
        ),
        createDocumentPlaceholderToken(),
        rendered,
      );

      warnMissingDocumentComponents(rendered);

      expect(warn).toHaveBeenCalledWith(
        "Your custom Document (pages/_document) did not render all the required subcomponents.\n" +
          "Missing components: <Head />, <NextScript />, <Html />\n" +
          "Read how to fix here: https://nextjs.org/docs/messages/missing-document-component",
      );
    });

    it("stays quiet for a complete Document", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const rendered = new Set<DocumentComponentName>();
      await renderDocument(
        React.createElement(
          Html,
          null,
          React.createElement(Head),
          React.createElement(
            "body",
            null,
            React.createElement(Main),
            React.createElement(NextScript),
          ),
        ),
        createDocumentPlaceholderToken(),
        rendered,
      );

      warnMissingDocumentComponents(rendered);

      expect(warn).not.toHaveBeenCalled();
    });
  });
});
