import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { loadCacheFlightCodec } from "./helpers/cache-flight-codec.js";
import {
  patchCacheFlightCodec,
  patchFlightSharedBufferDetach,
  readFlightCodecVersion,
} from "../packages/vinext/src/plugins/cache-flight-codec.js";
import {
  snapshotFlightReply,
  restoreFlightReply,
} from "../packages/vinext/src/shims/cache-flight-arguments.js";

// React permits one renderer per module instance; exercise both argument codecs
// using the same result renderer for the capture/result sides of the boundary.
const resultCodec = loadCacheFlightCodec();

describe("Flight cache codec", () => {
  it.each(["production", "development"] as const)(
    "roundtrips captured asynchronous React elements (%s)",
    async (mode) => {
      const codec = loadCacheFlightCodec(mode);
      async function AsyncChild() {
        await Promise.resolve();
        return createElement("span", null, "async child");
      }
      for (const value of [
        createElement(AsyncChild),
        Promise.resolve(createElement("span", null, "promise child")),
      ]) {
        const captures = await codec.createFromReadableStream(
          resultCodec.renderToReadableStream([value]),
        );
        const clientReferences = codec.createClientTemporaryReferenceSet();
        const reply = await codec.encodeReply([captures], {
          temporaryReferences: clientReferences,
        });
        const serverReferences = codec.createTemporaryReferenceSet();
        const args = await codec.decodeReply(restoreFlightReply(await snapshotFlightReply(reply)), {
          temporaryReferences: serverReferences,
        });
        const result = await codec.createFromReadableStream(
          resultCodec.renderToReadableStream(args[0][0], { temporaryReferences: serverReferences }),
          { temporaryReferences: clientReferences },
        );
        expect(result).toMatchObject({ type: "span" });
      }
    },
  );

  const elementCase = `
    function resolveToJSON(key, value) {
      switch (value.$$typeof) {
        case REACT_ELEMENT_TYPE:
          if (void 0 !== temporaryReferences && -1 === key.indexOf(":")) {
            return "$T";
          }
          throw Error("React Element cannot be passed to Server Functions");
      }
    }
  `;

  it.each(["19.2.6", "19.2.8"])("backports the root-element branch for React %s", (version) => {
    const patched = patchCacheFlightCodec(elementCase, "codec.js", version);
    expect(patched?.code.match(/modelRoot === value/g)).toHaveLength(1);
  });

  it.each(["19.3.0", "19.3.0-canary-d75b0697-20261006", "0.0.0-experimental-d75b0697-20261006"])(
    "leaves React %s untouched",
    (version) => {
      expect(patchCacheFlightCodec(elementCase, "codec.js", version)).toBeNull();
    },
  );

  it("asks for an upgrade when an older encoder has an unknown shape", () => {
    expect(() =>
      patchCacheFlightCodec("exports.encodeReply = somethingElse;", "codec.js", "19.2.8"),
    ).toThrow("Upgrade react, react-dom, and react-server-dom-webpack to 19.3 or later");
  });

  it("reads the version of the codec plugin-rsc resolved", () => {
    const vendored = createRequire(import.meta.url).resolve(
      "@vitejs/plugin-rsc/vendor/react-server-dom/client.edge",
    );
    const vendoredVersion = JSON.parse(
      fs.readFileSync(path.join(path.dirname(vendored), "package.json"), "utf8"),
    ).version;
    expect(
      readFlightCodecVersion(
        path.join(path.dirname(vendored), "cjs/react-server-dom-webpack-client.edge.production.js"),
      ),
    ).toBe(vendoredVersion);

    // An app's own react-server-dom-webpack takes precedence over the vendored copy.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-rsdw-"));
    try {
      const pkg = path.join(root, "node_modules", "react-server-dom-webpack");
      fs.mkdirSync(path.join(pkg, "cjs"), { recursive: true });
      fs.writeFileSync(
        path.join(pkg, "package.json"),
        JSON.stringify({ name: "react-server-dom-webpack", version: "19.3.0" }),
      );
      expect(
        readFlightCodecVersion(
          path.join(pkg, "cjs/react-server-dom-webpack-client.edge.production.js"),
        ),
      ).toBe("19.3.0");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// GHSA-h3gv-c5rc-p453: React 19.3's `emitTypedArrayChunk` serializes a Uint8Array
// as a view over the caller's backing buffer and enqueues large views directly,
// which detaches the buffer. Two large views over one buffer therefore corrupt
// each other, and vinext re-reads every "use cache" result server-side, so the
// stale row over-reads into attacker-controlled bytes. The transform restores the
// 19.2 copy that gives each chunk its own buffer.
describe("Flight shared-buffer detach backport", () => {
  // The unguarded 19.3 shape: the view is assigned straight onto `typedArray`
  // with no copy (matches both the prod and dev vendored builds).
  const unguarded = `
    function emitTypedArrayChunk(request, id, tag, typedArray, debug) {
      debug ? request.pendingDebugChunks++ : request.pendingChunks++;
      typedArray = new Uint8Array(
        typedArray.buffer,
        typedArray.byteOffset,
        typedArray.byteLength
      );
      debug = typedArray.byteLength;
    }
    function emitTextChunk() {}
  `;

  // The 19.2 shape, which already copies large views before enqueuing.
  const alreadyCopied = `
    function emitTypedArrayChunk(request, id, tag, typedArray, debug) {
      debug = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
      typedArray = 2048 < typedArray.byteLength ? debug.slice() : debug;
    }
    function emitTextChunk() {}
  `;

  it.each(["19.3.0", "19.3.1", "19.4.0", "20.0.0", "0.0.0-experimental-d75b0697-20261006"])(
    "copies large typed arrays before enqueuing for React %s",
    (version) => {
      const patched = patchFlightSharedBufferDetach(unguarded, "codec.js", version);
      expect(patched?.code).toContain(
        "typedArray = 2048 < typedArray.byteLength ? typedArray.slice() : typedArray;",
      );
      // The copy is inserted immediately after the view is built, before its
      // length is read, so the enqueued chunk owns its own buffer.
      expect(patched?.code.indexOf(".slice()")).toBeLessThan(
        patched!.code.indexOf("debug = typedArray.byteLength"),
      );
    },
  );

  it.each(["19.2.6", "19.2.8", "18.3.1"])("leaves React %s untouched", (version) => {
    expect(patchFlightSharedBufferDetach(unguarded, "codec.js", version)).toBeNull();
  });

  it("skips a 19.3 build that already copies large typed arrays", () => {
    expect(patchFlightSharedBufferDetach(alreadyCopied, "codec.js", "19.3.0")).toBeNull();
  });

  it("reports an unrecognized emitTypedArrayChunk shape rather than shipping it unpatched", () => {
    const unknown = `
      function emitTypedArrayChunk(request, id, tag, typedArray, debug) {
        request.completedRegularChunks.push(id, typedArray);
      }
      function emitTextChunk() {}
    `;
    expect(() => patchFlightSharedBufferDetach(unknown, "codec.js", "19.3.0")).toThrow(
      "unrecognized",
    );
  });

  it("reports a missing emitTypedArrayChunk rather than shipping it unpatched", () => {
    expect(() =>
      patchFlightSharedBufferDetach("exports.renderToReadableStream = x;", "codec.js", "19.3.0"),
    ).toThrow("cannot locate emitTypedArrayChunk");
  });

  it.each(["production", "development"] as const)(
    "patches the vendored React server codec plugin-rsc resolves (%s)",
    (mode) => {
      const require = createRequire(import.meta.url);
      const root = path.dirname(
        require.resolve("@vitejs/plugin-rsc/vendor/react-server-dom/client.edge"),
      );
      const filename = path.join(
        root,
        `cjs/react-server-dom-webpack-server.edge.${mode}.js`,
      );
      const source = fs.readFileSync(filename, "utf8");
      // The shipped vendored codec genuinely lacks the copy (so the test is
      // meaningful), and our transform inserts it.
      const emit = /function emitTypedArrayChunk\([\s\S]*?(?=\n *function )/.exec(source)![0];
      expect(emit).not.toContain(".slice()");
      const patched = patchFlightSharedBufferDetach(source, filename);
      expect(patched?.code).toContain(
        "typedArray = 2048 < typedArray.byteLength ? typedArray.slice() : typedArray;",
      );
    },
  );

  it("keeps two large views over one buffer intact through the real server codec", async () => {
    // Two 5000-byte views over a single 10000-byte ArrayBuffer, followed by
    // attacker-controlled text. Without the copy, emitting the first view
    // detaches the buffer, truncating the second and letting its stale Flight
    // row over-read into the trailing text — the shape behind the advisory.
    const buffer = new ArrayBuffer(10000);
    const first = new Uint8Array(buffer, 0, 5000).fill(0x41);
    const second = new Uint8Array(buffer, 5000).fill(0x42);
    const carrier = "injected:row-marker";
    const stream = resultCodec.renderToReadableStream({
      first: Promise.resolve(first),
      second: Promise.resolve(second),
      carrier,
    });
    const decoded = (await resultCodec.createFromReadableStream(stream)) as {
      first: Promise<Uint8Array>;
      second: Promise<Uint8Array>;
      carrier: string;
    };
    const decodedFirst = await decoded.first;
    const decodedSecond = await decoded.second;
    expect(decodedFirst.byteLength).toBe(5000);
    expect(decodedSecond.byteLength).toBe(5000);
    expect(decodedFirst.every((byte) => byte === 0x41)).toBe(true);
    expect(decodedSecond.every((byte) => byte === 0x42)).toBe(true);
    expect(decoded.carrier).toBe(carrier);
  });
});
