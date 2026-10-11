// The idea box. In the design studio a shopper puts a color and a print on a piece and
// sends it to Piper & Quinn. This keeps the idea.
//
//   GET  /api/idea           Is the idea box set up? Asks nobody and writes nothing.
//   GET  /api/idea?check=1   Proves it: writes a small test note, reads it back, removes
//                            it, and counts the ideas.
//   POST /api/idea           { "piece", "color", "print", "ink", "name", "note" }
//                            Answers { ok: true, id, same, count }. "same" is how many
//                            ideas with that piece, color, print and ink were there
//                            before. "count" is how many ideas there are now.
//
// What is kept for one idea: the time, the piece, the color, the print and its color, her
// name for the design, her note, and the site's address. Nothing else: no IP address, no
// user agent, no cookie. Her name and her note are never written to a log.

import { OUR_HOSTS, json, fail } from "../lib/tryon-core.mjs";
import { MAX_BODY, storeFor, limit, readIdea, comboOf, stamp, openBox, boxTrouble, about, log } from "../lib/idea-core.mjs";

const UNREADABLE = "We couldn't read that idea. Try sending it again.";

export default async (req) => {
  try {
    const url = new URL(req.url);
    if (req.method === "GET") return await check(url);
    if (req.method === "POST") return await keep(req, url);
    return fail(405, "wrong_method", "This address takes GET and POST.", undefined, { Allow: "GET, POST" });
  } catch (e) {
    // Only the kind of error is logged. Its words could repeat what she sent.
    log("crash", "our_mistake", e && e.name);
    return fail(500, "our_mistake", "Something broke on our side. Try again later.");
  }
};

export const config = {
  path: "/api/idea",
  // One shopper sends a few ideas, so one address can only send a few a minute.
  rateLimit: { windowLimit: 6, windowSize: 60, aggregateBy: ["ip", "domain"] },
};

async function check(url) {
  const store = storeFor(url.host);
  const box = openBox(store);
  const proving = url.searchParams.has("check");
  // The answer. "count" is only there when the store was asked.
  const say = (ready, says, count) =>
    json(200, { ok: true, service: "ideas", ready, store, ...(proving ? { count: count == null ? null : count } : {}), says });

  if (!box) return say(false, "Not set up: Netlify has not given the function its Blobs details.");
  if (!proving) return say(true, "Netlify has given the function its Blobs details. The store has not been tried: add ?check=1.");

  const at = new Date().toISOString();
  const key = "check/" + stamp(at);
  const note = { check: at };
  let step = "the test note could not be written";
  let count;
  try {
    await box.put(key, note);
    step = "the test note was written but could not be read back";
    const back = await box.text(key);
    step = "the test note was written and read back, but could not be removed";
    await box.remove(key);
    if (back === null) {
      log("check", "not_found");
      return say(false, "Not ready: the test note was written, but it was not there when read back.");
    }
    if (back !== JSON.stringify(note)) {
      log("check", "changed");
      return say(false, "Not ready: the test note came back changed.");
    }
    step = "the test note was written, read back and removed, but the ideas could not be counted";
    count = (await box.keys("idea/")).length;
  } catch (e) {
    const [, code, , , why] = boxTrouble(e);
    log("check", code, about(e));
    return say(false, "Not ready: " + step + ". Cause: " + why + ".");
  }
  return say(true, "Ready. A test note was written, read back and removed. The box holds " + count + (count === 1 ? " idea." : " ideas."), count);
}

async function keep(req, url) {
  // Only the site's own pages may send an idea. The rule is the one try-on uses: a browser
  // always says which page a POST came from.
  const from = req.headers.get("origin");
  if (from) {
    let page = null;
    try {
      page = new URL(from);
    } catch (_) {
      page = null;
    }
    if (!page || !/^https?:$/.test(page.protocol) || !(page.host === url.host || OUR_HOSTS.test(page.host))) {
      return fail(403, "wrong_site", "Ideas can only be sent from the Piper & Quinn site.");
    }
  }
  const type = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return fail(415, "not_json", UNREADABLE);

  const box = openBox(storeFor(url.host));
  if (!box) {
    log("keep", "not_set_up");
    return fail(503, "not_set_up", "The idea box isn't set up yet.");
  }

  let raw;
  try {
    raw = await req.text();
  } catch (_) {
    return fail(400, "cut_off", "Your idea didn't arrive whole. Try again.");
  }
  if (raw.length > MAX_BODY) return fail(413, "too_big", "That's too much to send at once. Make it shorter and try again.");
  let body;
  try {
    body = JSON.parse(raw);
  } catch (_) {
    return fail(400, "not_json", UNREADABLE);
  }
  if (!body || typeof body !== "object") return fail(400, "not_json", UNREADABLE);

  const read = readIdea(body);
  if (read.no) return fail(400, read.no[0], read.no[1]);

  // Exactly what is kept. Nothing about who sent it.
  const at = new Date().toISOString();
  const idea = { at, ...read.idea, site: url.host };
  const combo = comboOf(idea);
  const key = combo + stamp(at);
  let before;
  try {
    // One listing gives both numbers. No counter is kept, so none can drift.
    before = await box.keys("idea/");
    const max = limit();
    if (before.length >= max) {
      log("keep", "full", before.length + " of " + max);
      return fail(503, "full", "The idea box is full for now.");
    }
    await box.put(key, idea);
  } catch (e) {
    const [status, code, words, retry] = boxTrouble(e);
    log("keep", code, about(e));
    return fail(status, code, words, { retry });
  }
  return json(200, {
    ok: true,
    id: key,
    same: before.filter((k) => k.startsWith(combo)).length,
    count: before.length + 1,
  });
}
