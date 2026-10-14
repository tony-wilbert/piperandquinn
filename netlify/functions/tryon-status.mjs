// Try-on, step two: has FASHN finished the look?
//
//   GET /api/tryon-status?id=<the id /api/tryon gave>
//
//   still working   { ok: true, state: "working" }
//   finished        { ok: true, state: "done", image: "data:image/jpeg;base64,..." }
//   failed          { ok: false, code, message }   with the cause in words
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
    if (typeof out === "string" && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(out)) {
      return json(200, { ok: true, state: "done", image: out });
    }
    if (typeof out === "string" && /^https:\/\/([a-z0-9-]+\.)*fashn\.ai\//.test(out)) {
      return json(200, { ok: true, state: "done", image: out });
    }
    if (typeof out === "string" && /_expired$/.test(out)) {
      return fail(410, "gone", "That look has run out. Make it again.");
    }
    log("status", "fashn_error", "completed with no picture");
    return fail(502, "fashn_error", "FASHN said the look was done but sent no picture. Try again.");
  }
  if (state === "failed") {
    const [status, code, words] = failure(r.data.error);
    log("status", code, ((r.data.error && r.data.error.name) || "") + " " + ((r.data.error && r.data.error.message) || ""));
    return fail(status, code, words);
  }
  log("status", "fashn_error", "unknown status " + state);
  return fail(502, "fashn_error", "FASHN gave a status we didn't expect. Try again.");
};

export const config = {
  path: "/api/tryon-status",
  // The page asks every two seconds while a look is being made.
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
