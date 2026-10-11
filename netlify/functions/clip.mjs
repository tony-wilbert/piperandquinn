// A tool for a day, not part of the shop. It makes a clip of each sister talking, for the
// home page. Take it out of the site once the clips are made.
//
//   GET  /api/clip    Which clips it has started, and how many it may still start.
//                     Asks FASHN nothing and spends nothing.
//   POST /api/clip    { "who": "piper" } or { "who": "quinn" }
//                     Asks FASHN for a five second clip of her talking. The clip starts on
//                     her still and ends on it, so the page can play it round and round.
//                     The still is the one on the site this tool runs on, whichever of our
//                     pages asked. Three FASHN credits. Answers { ok: true, id, who }. The
//                     clip is picked up from /api/tryon-status?id=...
//
// What it cannot do: take a picture or words from the caller, or start a sister's clip more
// than once. Each start is counted in Netlify Blobs before FASHN is asked. A start FASHN
// turns down is not counted.

import { randomBytes } from "node:crypto";
import { OUR_HOSTS, setting, json, fail, clip, log, askFashn, refusal, failure } from "../lib/tryon-core.mjs";
import { openBox, boxTrouble, about } from "../lib/idea-core.mjs";

const MOST = 1; // of each sister: Tony said yes to one clip of each, six credits in all
const SETTLE_MS = 400;
const STORE = "clips-preview";
const MARK = "talk-"; // the marks of 11 October's walking clips begin "clip-" and are not counted here

// Her still on the site, and what she does in the clip.
const CLIPS = {
  piper: {
    still: "/img/piper-full.jpg",
    words: "She turns her head to the camera and talks, smiling. The camera stays still.",
  },
  quinn: {
    still: "/img/quinn-full.jpg",
    words: "She talks to the camera, smiling. The camera stays still.",
  },
};

export default async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") return count();
  if (req.method === "POST") return start(req, url);
  return fail(405, "wrong_method", "This address takes GET and POST.", undefined, { Allow: "GET, POST" });
};

export const config = {
  path: "/api/clip",
  rateLimit: { windowLimit: 6, windowSize: 60, aggregateBy: ["ip", "domain"] },
};

function trouble(where, e) {
  const [status, code, , retry, cause] = boxTrouble(e);
  log("clip " + where, code, about(e));
  return fail(status, code, "The count of clips could not be read or kept: " + cause + ". Nothing was asked of FASHN.", { retry });
}

async function count() {
  const box = openBox(STORE);
  if (!box) return json(200, { ok: true, service: "clips", ready: false, says: "Not set up: Netlify has not given the function its Blobs details." });
  const started = {};
  let left = 0;
  try {
    for (const who of Object.keys(CLIPS)) {
      started[who] = (await box.keys(MARK + who + "-")).length;
      left += Math.max(0, MOST - started[who]);
    }
  } catch (e) {
    return trouble("count", e);
  }
  return json(200, { ok: true, service: "clips", ready: !!setting("FASHN_API_KEY"), started, left, says: left ? "It may start " + left + " more." : "It has started all the clips it may." });
}

async function start(req, url) {
  // Only a page of the site itself may start a clip, and it must say so.
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
  const who = body && typeof body === "object" && typeof body.who === "string" ? body.who : "";
  if (!Object.hasOwn(CLIPS, who)) return fail(400, "no_such_clip", "There is a clip of piper and one of quinn, and no other.");
  if (Object.keys(body).length !== 1) return fail(400, "too_much", "This address takes one thing: who.");

  const key = setting("FASHN_API_KEY");
  if (!key) {
    log("clip start", "not_set_up");
    return fail(503, "not_set_up", "The FASHN_API_KEY setting is missing.");
  }
  const box = openBox(STORE);
  if (!box) return fail(503, "not_set_up", "Netlify has not given the function its Blobs details, so clips cannot be counted. Nothing was asked of FASHN.");

  // Count before asking. The mark goes in first, and the count is read again after it: of
  // two starts at the same moment, the one whose mark sorts past the limit stands down.
  const hers = MARK + who + "-";
  const mine = hers + String(Date.now()).padStart(15, "0") + "-" + randomBytes(4).toString("hex");
  const made = "Her clip has been started already. This tool starts it once.";
  let place;
  try {
    if ((await box.keys(hers)).length >= MOST) return fail(429, "all_made", made);
    await box.put(mine, { who, at: new Date().toISOString() });
    await new Promise((done) => setTimeout(done, SETTLE_MS)); // let a start made at the same moment put its mark in
    place = (await box.keys(hers)).sort().indexOf(mine);
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
      log("clip start", "mark_left", about(e));
    }
  };

  const c = CLIPS[who];
  const still = url.origin + c.still;
  const r = await askFashn("/run", key, {
    method: "POST",
    ms: 25000,
    body: { model_name: "image-to-video", inputs: { image: still, end_image: still, prompt: c.words, duration: 5, resolution: "720p" } },
  });
  if (r.status >= 200 && r.status < 300 && r.data && typeof r.data.id === "string" && r.data.id && !r.data.error) {
    return json(200, { ok: true, id: r.data.id, who });
  }
  if (r.status >= 200 && r.status < 300 && r.data && r.data.error && typeof r.data.error === "object") {
    await giveBack();
    const [status, code, words] = failure(r.data.error);
    log("clip start", code, r.data.error.name + " " + clip(r.data.error.message));
    return fail(status, code, words);
  }
  if (r.status >= 200 && r.status < 300) {
    // FASHN may have started something: the mark stays, so the limit cannot be passed.
    log("clip start", "fashn_error", "2xx with no id");
    return fail(502, "fashn_error", "FASHN took the request but gave no clip to wait for.");
  }
  if (r.status !== 0) await giveBack(); // a plain no from FASHN: nothing was started
  const [status, code, words, retry] = refusal(r);
  log("clip start", code, (r.data && (r.data.error + " " + r.data.message)) || "status " + r.status);
  return fail(status, code, words, { retry });
}
