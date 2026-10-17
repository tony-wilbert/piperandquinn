// Try-on, step two: has FASHN finished the look?
//
//   GET /api/tryon-status?id=<the id /api/tryon gave>
//
//   still working   { ok: true, state: "working" }
//   finished        { ok: true, state: "done", image: "data:image/jpeg;base64,..." }
//   failed          { ok: false, code, message }   with the cause in words
//
// A look that came back in a form not known here also answers what that form was (`shape`),
// with nothing of the picture in it.
//
// The picture is passed straight back to the page. Nothing here stores it.

import { setting, json, fail, log, askFashn, refusal, failure } from "../lib/tryon-core.mjs";

export default async (req) => {
  if (req.method !== "GET") {
    return fail(405, "wrong_method", "This address takes GET.", undefined, { Allow: "GET" });
  }
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{5,99}$/.test(id)) {
    return fail(400, "no_such_look", "That isn't a look we know.");
  }
  const key = setting("FASHN_API_KEY");
  if (!key) {
    log("status", "not_set_up");
    return fail(503, "not_set_up", "Try-on isn't set up yet: the FASHN_API_KEY setting is missing.");
  }

  const r = await askFashn("/status/" + id, key, { ms: 15000 });
  if (r.status !== 200 || !r.data) {
    const [status, code, words, retry] = refusal(r);
    log("status", code, (r.data && (r.data.error + " " + r.data.message)) || "status " + r.status);
    return fail(status, code, words, { retry });
  }

  const state = r.data.status;
  if (state === "starting" || state === "in_queue" || state === "processing") {
    return json(200, { ok: true, state: "working" });
  }
  if (state === "completed") {
    const out = Array.isArray(r.data.output) ? r.data.output[0] : null;
    const image = picture(out);
    if (image) return json(200, { ok: true, state: "done", image });
    if (typeof out === "string" && /_expired$/.test(out)) {
      return fail(410, "gone", "That look has run out. Make it again.");
    }
    log("status", "fashn_error", "completed with no picture: " + shape(out));
    return fail(502, "fashn_error", "FASHN said the look was done but sent no picture. Try again.", { shape: shape(out) });
  }
  if (state === "failed") {
    const [status, code, words] = failure(r.data.error);
    log("status", code, ((r.data.error && r.data.error.name) || "") + " " + ((r.data.error && r.data.error.message) || ""));
    return fail(status, code, words);
  }
  log("status", "fashn_error", "unknown status " + state);
  return fail(502, "fashn_error", "FASHN gave a status we didn't expect. Try again.");
};

// The look's picture as FASHN sends it, as a data URI or an address on fashn.ai: a data URI
// (image/jpg is taken as image/jpeg), base64 with no label, which is read by its first bytes,
// or an address. An object is looked into for one of those. Anything else is no picture.
function picture(out) {
  if (out && typeof out === "object") {
    for (const k of ["image", "url", "base64", "data", "output"]) if (typeof out[k] === "string") return picture(out[k]);
    return null;
  }
  if (typeof out !== "string") return null;
  const s = out.trim();
  const m = /^data:image\/(jpeg|jpg|png|webp)(;[A-Za-z0-9=._-]+)*;base64,/i.exec(s);
  if (m) {
    const b64 = s.slice(m[0].length).replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
    const kind = m[1].toLowerCase() === "jpg" ? "jpeg" : m[1].toLowerCase();
    return "data:image/" + kind + ";base64," + b64;
  }
  if (/^https:\/\/([a-z0-9-]+\.)*fashn\.ai\//.test(s)) return s;
  const b64 = s.replace(/\s+/g, "");
  if (b64.length > 200 && /^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    if (b64.startsWith("/9j/")) return "data:image/jpeg;base64," + b64;
    if (b64.startsWith("iVBORw0KGgo")) return "data:image/png;base64," + b64;
    if (b64.startsWith("UklGR")) return "data:image/webp;base64," + b64;
  }
  return null;
}

// What FASHN sent, told without any of the picture: for the log and the answer.
function shape(out) {
  if (out === null || out === undefined) return "nothing";
  if (Array.isArray(out)) return "a list of " + out.length;
  if (typeof out === "object") return "an object with " + Object.keys(out).slice(0, 8).join(", ");
  if (typeof out !== "string") return "a " + typeof out;
  const s = out.trim();
  if (s.startsWith("data:")) {
    const comma = s.indexOf(",");
    return s.slice(0, comma > 0 ? Math.min(comma + 1, 48) : 24) + " of " + s.length + " characters";
  }
  if (/^https?:\/\//.test(s)) {
    try {
      return "an address on " + new URL(s).host;
    } catch (_) {
      return "an address";
    }
  }
  return s.length + " characters, starting " + JSON.stringify(s.slice(0, 4));
}

export const config = {
  path: "/api/tryon-status",
  // The page asks every two seconds while a look is being made.
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
