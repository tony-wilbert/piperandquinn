// A tool for a day, not part of the shop. It makes Quinn's two clips again, from her new
// still on the golf course: her walk up to the camera, and her talking. Take it out of the
// site once the clips are made.
//
//   GET  /api/quinnclips    Which clips it has started, and how many it may still start.
//                           Asks FASHN nothing and spends nothing.
//   POST /api/quinnclips    { "clip": "walk" } or { "clip": "talk" }
//                           Asks FASHN for a five second clip at 720p from her new still on
//                           this site. Three FASHN credits. Answers { ok: true, id, clip }.
//                           The clip is picked up from /api/tryon-status?id=...
//
// What it cannot do: take a picture or words from the caller, or start a clip more than
// once. Each start is counted in Netlify Blobs before FASHN is asked. A start FASHN turns
// down is not counted.

import { randomBytes } from "node:crypto";
import { OUR_HOSTS, setting, json, fail, clip as cut, log, askFashn, refusal, failure } from "../lib/tryon-core.mjs";
import { openBox, boxTrouble, about } from "../lib/idea-core.mjs";

const MOST = 1; // of each: Tony said yes to the two clips, six credits, on 12 October 2026
const SETTLE_MS = 400;
const STORE = "clips-preview";
const MARK = "golf-"; // the marks of 11 October begin "clip-" and "talk-", and of the still "still-": not counted here
const STILL = "/img/tmp-still/quinn-golf.jpg";

// What she does in each clip. The talking clip starts and ends on her still, so the page can
// play it round and round.
export const CLIPS = {
  walk: { words: "She walks a few slow steps toward the camera across the grass, smiling, then stops and gives a little wave. The camera stays still.", last: false },
  talk: { words: "She talks to the camera, smiling. The camera stays still.", last: true },
};

export default async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") return count();
  if (req.method === "POST") return start(req, url);
  return fail(405, "wrong_method", "This address takes GET and POST.", undefined, { Allow: "GET, POST" });
};

export const config = {
  path: "/api/quinnclips",
  rateLimit: { windowLimit: 6, windowSize: 60, aggregateBy: ["ip", "domain"] },
};

function trouble(where, e) {
  const [status, code, , retry, cause] = boxTrouble(e);
  log("quinnclips " + where, code, about(e));
  return fail(status, code, "The count of clips could not be read or kept: " + cause + ". Nothing was asked of FASHN.", { retry });
}

async function count() {
  const box = openBox(STORE);
  if (!box) return json(200, { ok: true, service: "quinnclips", ready: false, says: "Not set up: Netlify has not given the function its Blobs details." });
  const started = {};
  let left = 0;
  try {
    for (const c of Object.keys(CLIPS)) {
      started[c] = (await box.keys(MARK + c + "-")).length;
      left += Math.max(0, MOST - started[c]);
    }
  } catch (e) {
    return trouble("count", e);
  }
  return json(200, { ok: true, service: "quinnclips", ready: !!setting("FASHN_API_KEY"), started, left, says: left ? "It may start " + left + " more." : "It has started all the clips it may." });
}

async function start(req, url) {
  let page = null;
  try {
    page = new URL(req.headers.get("origin") || "");
  } catch (_) {
    page = null;
  }
  if (!page || !/^https?:$/.test(page.protocol) || !(page.host === url.host || OUR_HOSTS.test(page.host))) {
    return fail(403, "wrong_site", "A clip can only be started from the Piper & Quinn site.");
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
  const which = body && typeof body === "object" && typeof body.clip === "string" ? body.clip : "";
  if (!Object.hasOwn(CLIPS, which)) return fail(400, "no_such_clip", "There is a walk and a talk, and no other.");
  if (Object.keys(body).length !== 1) return fail(400, "too_much", "This address takes one thing: clip.");

  const key = setting("FASHN_API_KEY");
  if (!key) {
    log("quinnclips start", "not_set_up");
    return fail(503, "not_set_up", "The FASHN_API_KEY setting is missing.");
  }
  const box = openBox(STORE);
  if (!box) return fail(503, "not_set_up", "Netlify has not given the function its Blobs details, so clips cannot be counted. Nothing was asked of FASHN.");

  const its = MARK + which + "-";
  const mine = its + String(Date.now()).padStart(15, "0") + "-" + randomBytes(4).toString("hex");
  const made = "That clip has been started already. This tool starts it once.";
  try {
    if ((await box.keys(its)).length >= MOST) return fail(429, "all_made", made);
    await box.put(mine, { clip: which, at: new Date().toISOString() });
    await new Promise((done) => setTimeout(done, SETTLE_MS));
    const place = (await box.keys(its)).sort().indexOf(mine);
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
      log("quinnclips start", "mark_left", about(e));
    }
  };

  const c = CLIPS[which];
  const still = url.origin + STILL;
  const inputs = { image: still, prompt: c.words, duration: 5, resolution: "720p" };
  if (c.last) inputs.end_image = still;
  const r = await askFashn("/run", key, { method: "POST", ms: 25000, body: { model_name: "image-to-video", inputs } });
  if (r.status >= 200 && r.status < 300 && r.data && typeof r.data.id === "string" && r.data.id && !r.data.error) {
    return json(200, { ok: true, id: r.data.id, clip: which });
  }
  if (r.status >= 200 && r.status < 300 && r.data && r.data.error && typeof r.data.error === "object") {
    await giveBack();
    const [status, code, words] = failure(r.data.error);
    log("quinnclips start", code, r.data.error.name + " " + cut(r.data.error.message));
    return fail(status, code, words);
  }
  if (r.status >= 200 && r.status < 300) {
    log("quinnclips start", "fashn_error", "2xx with no id");
    return fail(502, "fashn_error", "FASHN took the request but gave no clip to wait for.");
  }
  if (r.status !== 0) await giveBack();
  const [status, code, words, retry] = refusal(r);
  log("quinnclips start", code, (r.data && (r.data.error + " " + r.data.message)) || "status " + r.status);
  return fail(status, code, words, { retry });
}
