// A tool for a day, not part of the shop. It asks FASHN for new pictures of Quinn, on the
// same golf course as Piper's picture, for the home page. Take it out of the site once the
// pictures are made. This is its second form: the first, kept as still-1.mjs, worked from a
// course pieced together from Piper's photo, and its pictures did not match hers well
// enough. This one works from Piper's picture itself, for the place, the light and the camera.
//
//   GET  /api/still           Whether it has started its one run. Asks FASHN nothing.
//   GET  /api/still?id=...    How that run stands, and once it is done, the addresses of
//                             the pictures FASHN made.
//   POST /api/still           { "who": "quinn" }
//                             Asks FASHN's Edit for four pictures of Quinn: her still on this
//                             site, in the place, light and framing of Piper's. 2k, balanced:
//                             three FASHN credits a picture, twelve in all. Answers { ok, id }.
//
// What it cannot do: take a picture or words from the caller, or start more than one run.
// The start is counted in Netlify Blobs before FASHN is asked. A start FASHN turns down is
// not counted.

import { randomBytes } from "node:crypto";
import { OUR_HOSTS, setting, json, fail, clip, log, askFashn, refusal, failure } from "../lib/tryon-core.mjs";
import { openBox, boxTrouble, about } from "../lib/idea-core.mjs";

const MOST = 1; // Tony said yes to four more pictures, twelve credits, at 14:28 on 12 October 2026
const SETTLE_MS = 400;
const STORE = "clips-preview";
const MARK = "still2-quinn-"; // the first form's mark begins "still-quinn-" and is not counted here
const STILL = "/img/quinn-full.jpg";
const PLACE = "/img/piper-full.jpg"; // Piper's picture: for the place, the light and the camera only
export const PROMPT =
  "Use the reference image only for the place, the light and the camera. Do not copy the girl in it, her clothes, or the golf club. " +
  "Put her on that same golf course: the same lawn, palm trees, shrubs and blue sky, in the same bright, warm sunshine. " +
  "Shoot her the same way: the same low camera angle looking slightly up, with the sky behind her, and framed the same way, so that she fills the picture from just above her hair to just below her shoes. " +
  "She stands relaxed on the grass in a natural three-quarter pose, smiling, one hand in her skirt pocket. " +
  "Keep her face, hair, smile, sweatshirt, skirt and white sneakers exactly as they are. " +
  "Give her natural proportions for a ten year old girl, her legs slightly longer, in proportion to her height and face, and keep her natural build. " +
  "Only her in the picture.";
export const SHAPE = { resolution: "2k", generation_mode: "balanced", num_images: 4, output_format: "png" };

export default async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") return url.searchParams.has("id") ? status(url.searchParams.get("id") || "") : count();
  if (req.method === "POST") return start(req, url);
  return fail(405, "wrong_method", "This address takes GET and POST.", undefined, { Allow: "GET, POST" });
};

export const config = {
  path: "/api/still",
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] },
};

function trouble(where, e) {
  const [status, code, , retry, cause] = boxTrouble(e);
  log("still " + where, code, about(e));
  return fail(status, code, "The count could not be read or kept: " + cause + ". Nothing was asked of FASHN.", { retry });
}

async function count() {
  const box = openBox(STORE);
  if (!box) return json(200, { ok: true, service: "still", ready: false, says: "Not set up: Netlify has not given the function its Blobs details." });
  let started;
  try {
    started = (await box.keys(MARK)).length;
  } catch (e) {
    return trouble("count", e);
  }
  const left = Math.max(0, MOST - started);
  return json(200, { ok: true, service: "still", ready: !!setting("FASHN_API_KEY"), started, left, says: left ? "It may start its run." : "It has started its run." });
}

async function status(id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{5,99}$/.test(id)) return fail(400, "no_such_run", "That isn't a run we know.");
  const key = setting("FASHN_API_KEY");
  if (!key) return fail(503, "not_set_up", "The FASHN_API_KEY setting is missing.");
  const r = await askFashn("/status/" + id, key, { ms: 15000 });
  if (r.status !== 200 || !r.data) {
    const [st, code, words, retry] = refusal(r);
    log("still status", code, (r.data && (r.data.error + " " + r.data.message)) || "status " + r.status);
    return fail(st, code, words, { retry });
  }
  const state = r.data.status;
  if (state === "starting" || state === "in_queue" || state === "processing") return json(200, { ok: true, state: "working" });
  if (state === "completed") {
    const out = Array.isArray(r.data.output) ? r.data.output : [];
    const images = out.filter((u) => typeof u === "string" && /^https:\/\/([a-z0-9-]+\.)*fashn\.ai\/[^\s"'<>]+$/.test(u));
    if (!images.length) {
      log("still status", "fashn_error", "completed with no picture");
      return fail(502, "fashn_error", "FASHN said the run was done but sent no picture.");
    }
    return json(200, { ok: true, state: "done", images });
  }
  if (state === "failed") {
    const [st, code, words] = failure(r.data.error);
    log("still status", code, ((r.data.error && r.data.error.name) || "") + " " + ((r.data.error && r.data.error.message) || ""));
    return fail(st, code, words);
  }
  log("still status", "fashn_error", "unknown status " + state);
  return fail(502, "fashn_error", "FASHN gave a status we didn't expect.");
}

async function start(req, url) {
  // Only a page of the site itself may start the run, and it must say so.
  let page = null;
  try {
    page = new URL(req.headers.get("origin") || "");
  } catch (_) {
    page = null;
  }
  if (!page || !/^https?:$/.test(page.protocol) || !(page.host === url.host || OUR_HOSTS.test(page.host))) {
    return fail(403, "wrong_site", "The run can only be started from the Piper & Quinn site.");
  }
  const type = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return fail(415, "not_json", "Send JSON.");
  let raw;
  try {
    raw = await req.text();
  } catch (_) {
    return fail(400, "cut_off", "The request didn't arrive whole.");
  }
  if (raw.length > 200) return fail(413, "too_big", "That is more than this address takes.");
  let body;
  try {
    body = JSON.parse(raw);
  } catch (_) {
    return fail(400, "not_json", "Send JSON.");
  }
  if (!body || typeof body !== "object" || body.who !== "quinn") return fail(400, "no_such_picture", "This tool makes pictures of quinn, and no other.");
  if (Object.keys(body).length !== 1) return fail(400, "too_much", "This address takes one thing: who.");

  const key = setting("FASHN_API_KEY");
  if (!key) {
    log("still start", "not_set_up");
    return fail(503, "not_set_up", "The FASHN_API_KEY setting is missing.");
  }
  const box = openBox(STORE);
  if (!box) return fail(503, "not_set_up", "Netlify has not given the function its Blobs details, so the run cannot be counted. Nothing was asked of FASHN.");

  // Count before asking. The mark goes in first, and the count is read again after it: of
  // two starts at the same moment, the one whose mark sorts past the limit stands down.
  const mine = MARK + String(Date.now()).padStart(15, "0") + "-" + randomBytes(4).toString("hex");
  const made = "The run has been started already. This tool starts it once.";
  try {
    if ((await box.keys(MARK)).length >= MOST) return fail(429, "all_made", made);
    await box.put(mine, { who: "quinn", at: new Date().toISOString() });
    await new Promise((done) => setTimeout(done, SETTLE_MS));
    const place = (await box.keys(MARK)).sort().indexOf(mine);
    if (place < 0 || place >= MOST) {
      await box.remove(mine);
      return fail(429, "all_made", made);
    }
  } catch (e) {
    return trouble("start", e);
  }
  const giveBack = async () => {
    try {
      await box.remove(mine);
    } catch (e) {
      log("still start", "mark_left", about(e));
    }
  };

  const r = await askFashn("/run", key, {
    method: "POST",
    ms: 25000,
    body: { model_name: "edit", inputs: { image: url.origin + STILL, image_context: url.origin + PLACE, prompt: PROMPT, ...SHAPE } },
  });
  if (r.status >= 200 && r.status < 300 && r.data && typeof r.data.id === "string" && r.data.id && !r.data.error) {
    return json(200, { ok: true, id: r.data.id });
  }
  if (r.status >= 200 && r.status < 300 && r.data && r.data.error && typeof r.data.error === "object") {
    await giveBack();
    const [st, code, words] = failure(r.data.error);
    log("still start", code, r.data.error.name + " " + clip(r.data.error.message));
    return fail(st, code, words);
  }
  if (r.status >= 200 && r.status < 300) {
    // FASHN may have started something: the mark stays, so the limit cannot be passed.
    log("still start", "fashn_error", "2xx with no id");
    return fail(502, "fashn_error", "FASHN took the request but gave no run to wait for.");
  }
  if (r.status !== 0) await giveBack(); // a plain no from FASHN: nothing was started
  const [st, code, words, retry] = refusal(r);
  log("still start", code, (r.data && (r.data.error + " " + r.data.message)) || "status " + r.status);
  return fail(st, code, words, { retry });
}
