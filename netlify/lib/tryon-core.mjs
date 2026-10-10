// What the two try-on functions share: the pieces that can be tried on, the call to
// FASHN, and the words for every way it can fail.
//
// The FASHN key is read here from the FASHN_API_KEY setting. It goes into the
// Authorization header of a request to FASHN and nowhere else: never into an answer,
// never into a log.

export const FASHN = "https://api.fashn.ai/v1";
export const MODEL = "tryon-v1.6";
export const MODE = "quality"; // performance | balanced | quality (one credit either way)

// Product id in index.html -> garment picture in /img/tryon, and FASHN's name for its kind.
// The pictures show the garment only, no person.
//
// `cut`: FASHN first cuts the clothes she is wearing out of the photo (its
// segmentation_free setting, turned off). Without it both dresses kept pieces of the old
// clothes on 10 October 2026: a trouser leg, a sleeve. FASHN's documentation gives this
// setting for clothes that "are not removed properly".
export const GARMENTS = {
  1: { file: "burgundy-polo.jpg", category: "tops" },
  2: { file: "blush-sweater.jpg", category: "tops" },
  3: { file: "polka-dot-dress.jpg", category: "one-pieces", cut: true },
  4: { file: "lime-polo-dress.jpg", category: "one-pieces", cut: true },
  5: { file: "classic-polo.jpg", category: "tops" },
  6: { file: "pleated-skirt.jpg", category: "bottoms" },
  7: { file: "ruffle-skirt.jpg", category: "bottoms" },
};

// The site's own addresses: the live site, and Netlify's addresses for this project
// (the staging branch, deploy previews, single deploys). A look can only be started
// from a page on one of these, or on the address the function itself was reached at.
export const OUR_HOSTS = /^(www\.)?piperandquin\.com$|^([a-z0-9-]+--)?piperandquin\.netlify\.app$/;

// A setting, trimmed: pasted keys have arrived with spaces and line breaks.
export function setting(name) {
  let v = "";
  if (typeof process !== "undefined" && process.env && process.env[name]) v = process.env[name];
  else if (globalThis.Netlify && globalThis.Netlify.env) v = globalThis.Netlify.env.get(name) || "";
  return String(v).trim();
}

export function json(status, body, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(extra || {}),
    },
  });
}

// A failure always says its cause in words. `retry` tells the page the trouble may pass.
export function fail(status, code, message, more, headers) {
  return json(status, { ok: false, code, message, ...(more || {}) }, headers);
}

// Vendor text, made safe to log and to show: one line, short, and no photo data.
export function clip(s) {
  return String(s == null ? "" : s)
    .replace(/data:[^\s"']*/g, "<photo>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function log(where, code, detail) {
  console.error("[try-on] " + where + ": " + code + (detail ? " | " + clip(detail) : ""));
}

// One request to FASHN. Never throws: trouble on the way comes back as status 0.
export async function askFashn(path, key, opts) {
  const { method = "GET", body, ms = 15000 } = opts || {};
  let res;
  try {
    res = await fetch(FASHN + path, {
      method,
      headers: {
        Authorization: "Bearer " + key,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    const slow = !!e && (e.name === "TimeoutError" || e.name === "AbortError");
    return { status: 0, slow, data: null };
  }
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }
  return { status: res.status, data };
}

// FASHN said no before starting anything: no look was made and nothing was spent.
// Returns [http status, code, words, may it pass on its own?].
export function refusal(r) {
  if (r.status === 0) {
    return r.slow
      ? [504, "fashn_slow", "FASHN took too long to answer. Try again.", true]
      : [502, "fashn_unreachable", "Couldn't reach FASHN. Try again in a minute.", true];
  }
  const name = r.data && typeof r.data.error === "string" ? r.data.error : "";
  const said = clip(r.data && r.data.message);
  if (r.status === 401 || name === "UnauthorizedAccess") {
    return [502, "key_rejected", "Try-on is down: FASHN didn't accept the key.", false];
  }
  if (name === "OutOfCredits") {
    return [503, "out_of_credit", "Try-on is down: the FASHN account is out of credit.", false];
  }
  if (r.status === 429) {
    return [503, "busy", "Try-on is busy right now. Wait a minute and try again.", true];
  }
  if (r.status === 400 || name === "BadRequest") {
    return [502, "request_refused", "FASHN turned the request down" + (said ? ": " + said : "."), false];
  }
  if (r.status === 404) {
    return [404, "gone", "That look has run out. Make it again.", false];
  }
  if (r.status >= 500) {
    return [502, "fashn_error", "FASHN had a problem (" + r.status + "). Try again in a minute.", true];
  }
  return [502, "fashn_error", "FASHN gave an answer we didn't expect (" + r.status + ").", false];
}

// FASHN started the look and then failed. A failed look is not charged.
// Returns [http status, code, words].
export function failure(err) {
  const name = String((err && err.name) || "");
  const said = clip(err && err.message);
  switch (name) {
    case "ImageLoadError":
      return /garment/i.test(said)
        ? [502, "garment_unreadable", "FASHN couldn't load our picture of this piece."]
        : [422, "photo_unreadable", "We couldn't read that photo. Try a different one."];
    case "PoseError":
      return [422, "no_pose", "We couldn't find you in that photo. Use one where you're standing and facing the camera."];
    case "ContentModerationError":
      return [422, "photo_refused", "That photo can't be used for try-on. Try a different one."];
    case "InputValidationError":
      return [502, "request_refused", "FASHN turned the request down" + (said ? ": " + said : ".")];
    case "ThirdPartyError":
    case "UnavailableError":
    case "PipelineError":
      return [502, "fashn_error", "FASHN couldn't make the look this time. Try again."];
    default:
      return [502, "fashn_error", "FASHN couldn't make the look" + (name ? " (" + name + ")" : "") + ". Try again."];
  }
}
