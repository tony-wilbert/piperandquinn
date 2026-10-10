// Try-on, step one: take the shopper's photo and a piece, and ask FASHN to make the look.
//
//   GET  /api/tryon           Is try-on set up? Asks nobody and spends nothing.
//   GET  /api/tryon?check=1   Also asks FASHN whether the key works and credit is left,
//                             and checks the garment pictures load. Makes no look.
//   POST /api/tryon           { "product": 1, "photo": "data:image/jpeg;base64,..." }
//                             Answers { ok: true, id }. The look is picked up from
//                             /api/tryon-status?id=...
//
// The photo is passed straight to FASHN. Nothing here stores it or writes it to a log.

import { GARMENTS, MODEL, MODE, OUR_HOSTS, setting, json, fail, clip, log, askFashn, refusal, failure } from "../lib/tryon-core.mjs";

const MAX_PHOTO = 3000000; // characters; the page sends well under a third of this

export default async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") return check(url);
  if (req.method === "POST") return start(req, url);
  return fail(405, "wrong_method", "This address takes GET and POST.", undefined, { Allow: "GET, POST" });
};

export const config = {
  path: "/api/tryon",
  // Each look costs money, so one address can only start a few a minute.
  rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] },
};

async function check(url) {
  const key = setting("FASHN_API_KEY");
  const out = {
    ok: true,
    service: "try-on",
    ready: !!key,
    missing: key ? [] : ["FASHN_API_KEY"],
    model: MODEL,
    garments: url.origin + "/img/tryon/",
    asked_fashn: false,
    says: key
      ? "The key is set. FASHN has not been asked whether it works: add ?check=1."
      : "Not set up: the FASHN_API_KEY setting is missing.",
  };
  if (!url.searchParams.has("check") || !key) return json(200, out);

  const names = Object.values(GARMENTS).map((g) => g.file);
  const [credits, found] = await Promise.all([
    askFashn("/credits", key, { ms: 12000 }),
    Promise.all(names.map((f) => loads(url.origin + "/img/tryon/" + f))),
  ]);
  out.asked_fashn = true;
  out.garments_missing = names.filter((_, i) => !found[i]);

  if (credits.status === 200 && credits.data && credits.data.credits != null) {
    const c = credits.data.credits;
    const total = typeof c === "number" ? c : typeof c === "object" ? Number(c.total) : NaN;
    out.key_accepted = true;
    out.credit = Number.isFinite(total) ? total > 0 : null; // null: accepted, but the balance could not be read
  } else {
    const [, code, words] = refusal(credits);
    out.key_accepted = code === "key_rejected" ? false : null;
    out.fashn_problem = words;
    log("check", code, credits.data && credits.data.message);
  }

  out.ready = out.key_accepted === true && out.credit !== false && out.garments_missing.length === 0;
  if (out.ready && out.credit === null) {
    out.says = "Ready, with one thing unproven. FASHN accepts the key and all " + names.length + " garment pictures load, but the credit balance could not be read.";
  } else if (out.ready) {
    out.says = "Ready. FASHN accepts the key, the account has credit, and all " + names.length + " garment pictures load.";
  } else if (out.key_accepted === false) {
    out.says = "Not ready: FASHN didn't accept the key.";
  } else if (out.key_accepted === null) {
    out.says = "Not proven: " + out.fashn_problem;
  } else if (out.credit === false) {
    out.says = "Not ready: FASHN accepts the key, but the account is out of credit.";
  } else {
    out.says = "Not ready: these garment pictures don't load: " + out.garments_missing.join(", ") + ".";
  }
  return json(200, out);
}

async function loads(address) {
  try {
    const r = await fetch(address, { method: "HEAD", signal: AbortSignal.timeout(8000) });
    return r.ok && /^image\//.test(r.headers.get("content-type") || "");
  } catch (_) {
    return false;
  }
}

async function start(req, url) {
  // Only the site's own page may start a look. A browser always says which page a POST
  // came from; that address is also where the garment pictures live.
  let home = url.origin;
  const from = req.headers.get("origin");
  if (from) {
    let page = null;
    try {
      page = new URL(from);
    } catch (_) {
      page = null;
    }
    if (!page || !/^https?:$/.test(page.protocol) || !(page.host === url.host || OUR_HOSTS.test(page.host))) {
      return fail(403, "wrong_site", "Try-on only works from the Piper & Quinn site.");
    }
    home = page.origin;
  }
  const type = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return fail(415, "not_json", "Send the photo as JSON.");

  const key = setting("FASHN_API_KEY");
  if (!key) {
    log("start", "not_set_up");
    return fail(503, "not_set_up", "Try-on isn't set up yet: the FASHN_API_KEY setting is missing.");
  }

  let raw;
  try {
    raw = await req.text();
  } catch (_) {
    return fail(400, "cut_off", "The photo didn't arrive whole. Try again.");
  }
  if (raw.length > MAX_PHOTO + 2000) return fail(413, "photo_too_big", "That photo is too big. Try a smaller one.");
  let body;
  try {
    body = JSON.parse(raw);
  } catch (_) {
    return fail(400, "not_json", "Send the photo as JSON.");
  }
  if (!body || typeof body !== "object") return fail(400, "not_json", "Send the photo as JSON.");

  const piece = String(body.product == null ? "" : body.product);
  if (!Object.hasOwn(GARMENTS, piece)) return fail(400, "no_such_piece", "That piece doesn't have try-on yet.");
  const photo = body.photo;
  if (typeof photo !== "string" || !photo) return fail(400, "no_photo", "Add a photo first.");
  if (photo.length > MAX_PHOTO) return fail(413, "photo_too_big", "That photo is too big. Try a smaller one.");
  if (!isPhoto(photo)) return fail(400, "not_a_photo", "That file isn't a photo we can use. Try a JPG or PNG.");

  const g = GARMENTS[piece];
  const r = await askFashn("/run", key, {
    method: "POST",
    ms: 25000,
    body: {
      model_name: MODEL,
      inputs: {
        model_image: photo,
        garment_image: home + "/img/tryon/" + g.file,
        category: g.category,
        garment_photo_type: "flat-lay",
        moderation_level: "conservative",
        mode: MODE,
        seed: Math.floor(Math.random() * 4294967296),
        num_samples: 1,
        output_format: "jpeg",
        return_base64: true,
      },
    },
  });

  if (r.status >= 200 && r.status < 300 && r.data && typeof r.data.id === "string" && r.data.id && !r.data.error) {
    return json(200, { ok: true, id: r.data.id });
  }
  if (r.status >= 200 && r.status < 300 && r.data && r.data.error && typeof r.data.error === "object") {
    const [status, code, words] = failure(r.data.error);
    log("start", code, r.data.error.name + " " + clip(r.data.error.message));
    return fail(status, code, words);
  }
  if (r.status >= 200 && r.status < 300) {
    log("start", "fashn_error", "2xx with no id");
    return fail(502, "fashn_error", "FASHN took the photo but gave no look to wait for. Try again.");
  }
  const [status, code, words, retry] = refusal(r);
  log("start", code, (r.data && (r.data.error + " " + r.data.message)) || "status " + r.status);
  return fail(status, code, words, { retry });
}

// A data URI holding a real JPEG, PNG or WebP. Looks at the first bytes, not just the label.
function isPhoto(s) {
  const m = /^data:image\/(jpeg|png|webp);base64,/.exec(s.slice(0, 40));
  if (!m) return false;
  const b64 = s.slice(m[0].length);
  if (b64.length < 200 || b64.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return false;
  const head = Buffer.from(b64.slice(0, 24), "base64");
  if (m[1] === "jpeg") return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (m[1] === "png") return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP";
}
