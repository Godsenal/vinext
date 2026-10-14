import fs from "node:fs";
import path from "pathslash";
import MagicString from "magic-string";
import type { Plugin } from "vite";
import { magicStringTransformResult } from "./transform-result.js";

const CLIENT_CODEC =
  /\/react-server-dom-(?:webpack|turbopack)-client\.edge\.(?:development|production)\.js$/;

const SERVER_CODEC =
  /\/react-server-dom-(?:webpack|turbopack)-server\.edge\.(?:development|production)\.js$/;

const ELEMENT_CASE =
  /case REACT_ELEMENT_TYPE:[\s\S]*?throw Error\(\s*"React Element cannot be passed/;

/**
 * `emitTypedArrayChunk`, bounded by the next function declaration so the body
 * can be inspected independently of the rest of the codec (prod and dev builds
 * both place `emitTextChunk` immediately after it).
 */
const EMIT_TYPED_ARRAY_CHUNK = /function emitTypedArrayChunk\([\s\S]*?(?=\n *function )/;

/**
 * The unguarded view React 19.3 builds over the caller's backing buffer. 19.2
 * and earlier assign the view to a temporary and copy it with `.slice()` when it
 * is large enough to be enqueued directly; 19.3 dropped that copy.
 */
const TYPED_ARRAY_VIEW =
  /typedArray = new Uint8Array\(\s*typedArray\.buffer,\s*typedArray\.byteOffset,\s*typedArray\.byteLength\s*\);/;

/**
 * Version of the Flight codec package that owns `id`. plugin-rsc resolves the
 * app's own react-server-dom-webpack when installed and its vendored copy
 * otherwise; reading the codec file's own package.json follows that choice.
 */
export function readFlightCodecVersion(id: string): string {
  for (let dir = path.dirname(id); ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (/^react-server-dom-(?:webpack|turbopack)$/.test(pkg.name ?? "") && pkg.version) {
        return pkg.version;
      }
    }
    if (path.dirname(dir) === dir) {
      throw new Error(`vinext: cannot find the react-server-dom package version for ${id}`);
    }
  }
}

/** React 19.3 ships the branch; 0.0.0-* experimental builds track main. */
function needsElementTemporaryReferenceBackport(version: string): boolean {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (!match || version.startsWith("0.0.0-")) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major < 19 || (major === 19 && minor < 3);
}

/**
 * Backport React 19.3's root-element temporary reference branch to older Flight
 * codecs, so a "use cache" argument like `Promise<ReactElement>` encodes as a
 * temporary reference instead of throwing. Remove it once React 19.3 is the
 * minimum supported version.
 * https://github.com/facebook/react/blob/v19.3.0/packages/react-client/src/ReactFlightReplyClient.js#L486
 */
export function patchCacheFlightCodec(
  code: string,
  id: string,
  version = readFlightCodecVersion(id),
) {
  if (!needsElementTemporaryReferenceBackport(version)) return null;
  const elementCase = ELEMENT_CASE.exec(code);
  if (!elementCase) {
    throw new Error(
      `vinext: react-server-dom-webpack ${version} (${id}) is not supported. ` +
        "Upgrade react, react-dom, and react-server-dom-webpack to 19.3 or later. " +
        "If your app does not depend on react-server-dom-webpack directly, " +
        "upgrade @vitejs/plugin-rsc to 0.5.35 or later instead.",
    );
  }
  const output = new MagicString(code);
  output.appendLeft(
    elementCase.index + elementCase[0].lastIndexOf("throw Error("),
    'if (void 0 !== temporaryReferences && modelRoot === value) return (modelRoot = null), "$T";\n',
  );
  return magicStringTransformResult(output, { hires: "boundary", source: id });
}

/**
 * React 19.3 and later (plus `0.0.0-*` experimental builds, which track main)
 * dropped the copy; 19.2 and earlier keep it. See {@link patchFlightSharedBufferDetach}.
 */
function needsSharedBufferCopyBackport(version: string): boolean {
  if (version.startsWith("0.0.0-")) return true;
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 19 || (major === 19 && minor >= 3);
}

/**
 * Backport React 19.2's copy of large typed arrays to the 19.3 server codec.
 *
 * `emitTypedArrayChunk` serializes a `Uint8Array` as a view over the caller's
 * backing buffer. The edge stream enqueues a large view directly, and enqueuing
 * into a byte stream detaches its `ArrayBuffer`. When a single cached value
 * returns two large views over one buffer, emitting the first detaches the
 * buffer out from under the second, whose Flight row keeps its original length.
 * A server-side consumer of that stream (vinext re-reads every `"use cache"`
 * result with `createFromReadableStream`) then over-reads the stale row into the
 * bytes that follow it, so attacker-controlled text placed after the views can
 * inject new Flight rows — the shape behind GHSA-h3gv-c5rc-p453.
 *
 * React 19.2 and earlier copied any view larger than 2048 bytes with `.slice()`
 * before enqueuing, giving each chunk its own buffer; 19.3 removed the copy.
 * Restore it here until a fixed react-server-dom-webpack is the minimum
 * supported version. The copy is transparent: the serialized bytes are
 * identical, only the backing buffer differs.
 */
export function patchFlightSharedBufferDetach(
  code: string,
  id: string,
  version = readFlightCodecVersion(id),
) {
  if (!needsSharedBufferCopyBackport(version)) return null;
  const emit = EMIT_TYPED_ARRAY_CHUNK.exec(code);
  if (!emit) {
    throw new Error(
      `vinext: cannot locate emitTypedArrayChunk in react-server-dom-webpack ${version} (${id}). ` +
        "This build may be vulnerable to GHSA-h3gv-c5rc-p453; please report a vinext issue.",
    );
  }
  // A release that already copies large typed arrays (React 19.2 and earlier, or
  // a future 19.3 patch that restores the copy) needs no backport.
  if (emit[0].includes(".slice()")) return null;
  const view = TYPED_ARRAY_VIEW.exec(emit[0]);
  if (!view) {
    throw new Error(
      `vinext: react-server-dom-webpack ${version} (${id}) has an unrecognized ` +
        "emitTypedArrayChunk shape and may be vulnerable to GHSA-h3gv-c5rc-p453; " +
        "please report a vinext issue.",
    );
  }
  const output = new MagicString(code);
  output.appendRight(
    emit.index + view.index + view[0].length,
    "\n  typedArray = 2048 < typedArray.byteLength ? typedArray.slice() : typedArray;",
  );
  return magicStringTransformResult(output, { hires: "boundary", source: id });
}

export function cacheFlightCodecPlugin(): Plugin {
  const transform = {
    filter: { id: [CLIENT_CODEC, SERVER_CODEC] },
    handler: (code: string, id: string) =>
      SERVER_CODEC.test(id)
        ? patchFlightSharedBufferDetach(code, id)
        : patchCacheFlightCodec(code, id),
  };
  return {
    name: "vinext:cache-flight-codec",
    enforce: "pre",
    applyToEnvironment: (environment) => environment.name === "rsc",
    configEnvironment(name) {
      if (name !== "rsc") return;
      return {
        optimizeDeps: {
          rolldownOptions: {
            plugins: [{ name: "vinext:cache-flight-codec-optimizer", transform }],
          },
        },
      };
    },
    transform,
  };
}
