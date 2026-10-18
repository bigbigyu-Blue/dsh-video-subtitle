/**
 * The vendored feiyudo cipher bundle is browser code: it touches the bare global
 * `window` at module-eval time (window.crypto.getRandomValues, window.addEventListener).
 * This side-effect module installs the minimal global it expects.
 *
 * MUST be imported before ./feiyudo-cipher.js — ESM evaluates imports in order.
 */
if (typeof globalThis.window === "undefined") globalThis.window = globalThis;
