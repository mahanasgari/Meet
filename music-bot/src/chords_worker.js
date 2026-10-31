// Runs chord analysis off the main thread (a long song takes seconds of
// CPU, which would stall every request on the server).
import { parentPort } from "node:worker_threads";
import { analyze } from "./chords.js";

parentPort.on("message", ({ id, buffer }) => {
  try {
    parentPort.postMessage({ id, result: analyze(new Float32Array(buffer)) });
  } catch (e) {
    parentPort.postMessage({ id, error: String(e?.message || e) });
  }
});
