import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createElement, Fragment, isValidElement, type ReactElement } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { describe, expect, it } from "vite-plus/test";
import {
  createAppRenderDependency,
  getPendingCssWrappedResult,
  invokeAppComponent,
  renderAfterAppDependencies,
  renderAppComponentWithDependencyBarrier,
} from "../packages/vinext/src/server/app-render-dependency.js";

const execFileAsync = promisify(execFile);

/**
 * Run `body` through React Flight in a react-server subprocess, with
 * `React`, `renderToReadableStream` and the real helpers in scope as `mod`.
 * Returns what it writes to stdout.
 */
async function runInFlightServer(body: string): Promise<string> {
  const script = String.raw`
    import React from "react";
    import { createServer } from "vite";
    import { renderToReadableStream } from "./node_modules/@vitejs/plugin-rsc/dist/vendor/react-server-dom/server.edge.js";

    const vite = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      mode: "production",
      server: { middlewareMode: true },
    });

    try {
      const mod = await vite.ssrLoadModule(
        "/packages/vinext/src/server/app-render-dependency.tsx",
      );
      ${body}
    } finally {
      await vite.close();
    }
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--conditions", "react-server", "--input-type=module", "-e", script],
    {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "production" },
      timeout: 10_000,
    },
  );
  return stdout;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

async function renderHtml(element: React.ReactNode): Promise<string> {
  const stream = await renderToReadableStream(element, {
    onError(error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    },
  });
  await stream.allReady;
  return readStream(stream);
}

describe("app render dependency helpers", () => {
  it("documents that React can render a sync sibling before an async sibling completes", async () => {
    let activeLocale = "en";

    async function LocaleLayout() {
      await Promise.resolve();
      activeLocale = "de";
      return createElement("div", null, "layout");
    }

    function LocalePage() {
      return createElement("p", null, `page:${activeLocale}`);
    }

    const body = await renderHtml(
      createElement("div", null, createElement(LocaleLayout), createElement(LocalePage)),
    );

    expect(body).toContain("page:en");
  });

  it("waits to serialize dependent entries until the barrier entry has rendered", async () => {
    let activeLocale = "en";
    const layoutDependency = createAppRenderDependency();

    async function LocaleLayout() {
      await Promise.resolve();
      activeLocale = "de";
      return createElement("div", null, "layout");
    }

    function LocalePage() {
      return createElement("p", null, `page:${activeLocale}`);
    }

    const body = await renderHtml(
      createElement(
        "div",
        null,
        renderAppComponentWithDependencyBarrier(LocaleLayout, {}, layoutDependency),
        renderAfterAppDependencies(createElement(LocalePage), [layoutDependency]),
      ),
    );

    expect(body).toContain("page:de");
    expect(body).not.toContain("page:en");
  });

  it("releases a dependency after an async component produces its Flight result", async () => {
    // Run the real helper through React Flight in a react-server subprocess.
    // React DOM schedules the old fragment-sibling barrier differently and did
    // not expose the production ordering regression.
    const stdout = await runInFlightServer(String.raw`
        const { createAppRenderDependency, renderAppComponentWithDependencyBarrier } = mod;
        const events = [];

        function createLayout(name) {
          return async function Layout() {
            events.push(name + ":layout:start");
            await new Promise((resolve) => setTimeout(resolve, 25));
            events.push(name + ":layout:end");
            return React.createElement("section", null, name + " layout");
          };
        }

        const forwardRefLayout = createLayout("forwardRef");
        const cssLayout = createLayout("css");
        const layouts = {
          plain: createLayout("plain"),
          memo: React.memo(createLayout("memo")),
          lazy: React.lazy(async () => ({ default: createLayout("lazy") })),
          forwardRef: React.forwardRef((props, ref) => {
            events.push("forwardRef:ref:" + String(ref));
            return forwardRefLayout(props);
          }),
          // The shape of @vitejs/plugin-rsc's __vite_rsc_wrap_css__ wrapper.
          css: function CssWrapper(props) {
            return React.createElement(
              React.Fragment,
              null,
              React.createElement("link", { rel: "stylesheet", href: "/layout.css" }),
              React.createElement(cssLayout, props),
            );
          },
        };
        const model = {};

        for (const [name, Layout] of Object.entries(layouts)) {
          const dependency = createAppRenderDependency();
          model[name + ":layout"] = renderAppComponentWithDependencyBarrier(
            Layout,
            {},
            dependency,
          );
          model[name + ":page"] = React.createElement(async function Page() {
            await dependency.promise;
            events.push(name + ":page");
            return React.createElement("p", null, name + " page");
          });
        }

        const stream = renderToReadableStream(model, null, {
          onError: () => "digest",
        });
        const reader = stream.getReader();
        while (!(await reader.read()).done) {}
        process.stdout.write(JSON.stringify(events));
    `);

    const events = JSON.parse(stdout) as string[];
    for (const name of ["plain", "memo", "lazy", "forwardRef", "css"]) {
      expect(events.indexOf(`${name}:layout:start`)).toBeLessThan(
        events.indexOf(`${name}:layout:end`),
      );
      expect(events.indexOf(`${name}:layout:end`)).toBeLessThan(events.indexOf(`${name}:page`));
    }
    expect(events).toContain("forwardRef:ref:undefined");
    expect(events).not.toContain("forwardRef:ref:null");
  });

  it("streams a CSS-wrapped async layout's stylesheet before the layout resolves", async () => {
    const stdout = await runInFlightServer(String.raw`
        const { createAppRenderDependency, renderAppComponentWithDependencyBarrier } = mod;
        let finishLayout;
        const layoutGate = new Promise((resolve) => {
          finishLayout = resolve;
        });
        async function Layout() {
          await layoutGate;
          return React.createElement("section", null, "layout body");
        }
        // The shape of @vitejs/plugin-rsc's __vite_rsc_wrap_css__ wrapper.
        function CssWrapper(props) {
          return React.createElement(
            React.Fragment,
            null,
            React.createElement("link", { rel: "stylesheet", href: "/layout.css" }),
            React.createElement(Layout, props),
          );
        }
        const dependency = createAppRenderDependency();
        let released = false;
        void dependency.promise.then(() => {
          released = true;
        });
        const stream = renderToReadableStream(
          { layout: renderAppComponentWithDependencyBarrier(CssWrapper, {}, dependency) },
          null,
          { onError: () => "digest" },
        );
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        const first = await reader.read();
        const beforeLayout = { flight: decoder.decode(first.value), released };
        finishLayout();
        let flight = beforeLayout.flight;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          flight += decoder.decode(value);
        }
        process.stdout.write(JSON.stringify({ beforeLayout, flight, released }));
    `);

    const result = JSON.parse(stdout) as {
      beforeLayout: { flight: string; released: boolean };
      flight: string;
      released: boolean;
    };
    expect(result.beforeLayout.flight).toContain("/layout.css");
    expect(result.beforeLayout.flight).not.toContain("layout body");
    expect(result.beforeLayout.released).toBe(false);
    expect(result.flight).toContain("layout body");
    expect(result.released).toBe(true);
  });

  it("invokes a CSS-wrapped component without passing its props to an element", async () => {
    const props = { params: Promise.resolve({}), searchParams: Promise.resolve({}) };
    let receivedProps: unknown;
    function Page(pageProps: Record<string, unknown>) {
      receivedProps = pageProps;
      return createElement("p", null, "page");
    }
    // The shape of @vitejs/plugin-rsc's `__vite_rsc_wrap_css__` wrapper.
    function CssWrapper(wrapperProps: Record<string, unknown>) {
      return createElement(
        Fragment,
        null,
        createElement("link", { rel: "stylesheet", href: "/page.css" }),
        createElement(Page, wrapperProps),
      );
    }

    const result = invokeAppComponent(CssWrapper, props);
    if (!isValidElement<{ children: [unknown, ReactElement] }>(result)) {
      throw new Error("expected an element");
    }
    // Page ran directly, so no element got the props. React's dev build
    // serializes an element's props as debug info, which would call `then` on
    // params and searchParams.
    expect(receivedProps).toEqual(props);
    expect(result.props.children[1].type).toBe("p");

    const body = await renderHtml(result);
    expect(body).toContain('href="/page.css"');
    expect(body).toContain("<p>page</p>");
  });

  it("keeps the CSS of an async CSS-wrapped component ahead of its pending result", async () => {
    async function Page() {
      await Promise.resolve();
      return createElement("p", null, "page");
    }
    function CssWrapper(wrapperProps: Record<string, unknown>) {
      return createElement(Fragment, null, "css", createElement(Page, wrapperProps));
    }

    const result = invokeAppComponent(CssWrapper, { params: Promise.resolve({}) });
    if (!isValidElement<{ children: [unknown, ReactElement] }>(result)) {
      throw new Error("expected an element");
    }
    expect(result.props.children[0]).toBe("css");
    expect(result.props.children[1].props).toEqual({});
    const pendingResult = getPendingCssWrappedResult(result);
    expect(pendingResult).toBeInstanceOf(Promise);
    expect(isValidElement(await pendingResult)).toBe(true);
    expect(await renderHtml(result)).toBe("css<p>page</p>");
  });

  it("keeps the pending result of a CSS-wrapped component that is itself CSS-wrapped", async () => {
    async function Page() {
      await Promise.resolve();
      return createElement("p", null, "page");
    }
    function InnerCssWrapper(wrapperProps: Record<string, unknown>) {
      return createElement(Fragment, null, "inner-css", createElement(Page, wrapperProps));
    }
    function OuterCssWrapper(wrapperProps: Record<string, unknown>) {
      return createElement(
        Fragment,
        null,
        "outer-css",
        createElement(InnerCssWrapper, wrapperProps),
      );
    }

    const result = invokeAppComponent(OuterCssWrapper, { params: Promise.resolve({}) });
    if (!isValidElement(result)) throw new Error("expected an element");
    expect(getPendingCssWrappedResult(result)).toBeInstanceOf(Promise);
    expect(await renderHtml(result)).toBe("outer-css<!-- -->inner-css<p>page</p>");
  });

  it("invokes a CSS-wrapped component that has defaultProps with them applied", async () => {
    const props = { params: Promise.resolve({}), theme: undefined };
    let receivedProps: unknown;
    function Page(pageProps: Record<string, unknown>) {
      receivedProps = pageProps;
      return null;
    }
    Page.defaultProps = { theme: "dark", size: "small" };
    function CssWrapper(wrapperProps: Record<string, unknown>) {
      return createElement(Fragment, null, "css", createElement(Page, wrapperProps));
    }

    void invokeAppComponent(CssWrapper, props);
    expect(receivedProps).toEqual({ params: props.params, theme: "dark", size: "small" });
  });

  it("unwraps a CSS-wrapped component whose defaultProps have a getter", async () => {
    const props = { params: Promise.resolve({}) };
    let receivedTheme: unknown;
    function Page(pageProps: Record<string, unknown>) {
      receivedTheme = pageProps.theme;
      return null;
    }
    Page.defaultProps = {
      get theme() {
        return { mode: "dark" };
      },
    };
    function CssWrapper(wrapperProps: Record<string, unknown>) {
      return createElement(Fragment, null, "css", createElement(Page, wrapperProps));
    }

    void invokeAppComponent(CssWrapper, props);
    expect(receivedTheme).toEqual({ mode: "dark" });
  });

  it("keeps a keyed element in the fragment as rendered", () => {
    const props = { params: Promise.resolve({}) };
    function Child(_props: Record<string, unknown>) {
      return null;
    }
    function Layout(layoutProps: Record<string, unknown>) {
      return createElement(
        Fragment,
        null,
        "css",
        createElement(Child, { ...layoutProps, key: "route-a" }),
      );
    }

    const result = invokeAppComponent(Layout, props);
    if (!isValidElement<{ children: [unknown, ReactElement] }>(result)) {
      throw new Error("expected an element");
    }
    expect(result.props.children[1].type).toBe(Child);
    expect(result.props.children[1].key).toBe("route-a");
  });

  it("keeps a fragment whose element gets other props as rendered", () => {
    const props = { params: Promise.resolve({}) };
    function Child(_props: Record<string, unknown>) {
      return null;
    }
    function Layout() {
      return createElement(
        Fragment,
        null,
        "css",
        createElement(Child, { params: props.params, x: 1 }),
      );
    }

    const result = invokeAppComponent(Layout, props);
    if (!isValidElement<{ children: [unknown, ReactElement] }>(result)) {
      throw new Error("expected an element");
    }
    expect(result.props.children[1].type).toBe(Child);
  });
});
