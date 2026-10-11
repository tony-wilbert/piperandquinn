// What the idea box needs: the choices the design studio offers, the tidying of her words,
// the store, and the words for every way it can fail.
//
// Children use the site, so nothing that could identify one is kept. An idea holds no IP
// address, no user agent and no cookie. A name or a note that holds an email address, a web
// address, an @ name or a long number is refused. Her name and her note go into the store
// and nowhere else: never into a log, never back in an answer.
//
// No key or token is kept here. Netlify hands the function its Blobs credentials each time
// it runs, and the client in blobs-11.1.4.mjs reads them.

import { randomBytes } from "node:crypto";
import { getStore } from "./blobs-11.1.4.mjs";
import { setting, clip } from "./tryon-core.mjs";

// What the design studio offers. The names are the ones the page sends.
export const PIECES = ["burgundy-polo", "blush-sweater", "polka-dot-dress", "lime-polo-dress", "classic-polo", "pleated-skirt", "ruffle-skirt", "wide-leg-pants"];
export const COLORS = ["pq-green", "sky-blue", "grass", "orange-tee", "city-khaki", "coral", "lavender", "hot-pink", "sunshine", "ocean", "white", "midnight"];
export const PRINTS = ["classic-polka", "city-grid", "confetti-scatter", "cabana-stripe", "mod-block", "circle-link"];

export const MAX_BODY = 2000; // characters in one request
export const MAX_NAME = 30; // characters
export const MAX_NOTE = 140; // characters
export const MAX_IDEAS = 5000; // the box is full at this many
const WAIT_MS = 8000; // for all the store's answers to one request, together

// A Blobs store is shared by every deploy of the project. So the live site and the
// previews get a store each, picked by the address the request came to, and never share
// ideas.
const LIVE = ["piperandquin.com", "www.piperandquin.com", "piperandquin.netlify.app"];
export function storeFor(host) {
  return LIVE.includes(String(host).toLowerCase()) ? "ideas-live" : "ideas-preview";
}

// How many ideas the box holds before it is full. The IDEAS_MAX setting can change it.
export function limit() {
  const v = setting("IDEAS_MAX");
  return /^\d{1,9}$/.test(v) ? Number(v) : MAX_IDEAS;
}

// ---- her words ------------------------------------------------------------------

// Her words, tidied. Look-alike characters become the plain ones. A phone keyboard's curly
// apostrophes and long dashes become straight ones. Every run of spaces and line breaks
// becomes one space. Control characters and invisible characters are dropped. The joiner
// inside an emoji stays, or the emoji would fall apart.
function tidy(s) {
  return s
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/(?!\u200D)[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

// Does this hold something that could say who she is? Returns which kind, or "".
// It errs on the side of refusing: a dot between two words reads as a web address.
function gives(s) {
  const t = s.replace(/\u200D/g, "");
  if (/[^\s@]@[^\s@]+\.[^\s@]/.test(t)) return "email";
  if (t.includes("@")) return "handle";
  if (/https?:|:\/\/|\bwww\./i.test(t) || /[\p{L}\p{N}]\.\p{L}{2,}/u.test(t)) return "web";
  // Seven digits or more, with nothing between them but spaces and a phone number's marks.
  if (/\p{Nd}(?:[\s().+\/\p{M}-]*\p{Nd}){6,}/u.test(t)) return "number";
  return "";
}

const WHY = " We don't keep anything that could tell us who you are.";
function leaveOut(kind, where) {
  if (kind === "email") return "That looks like an email address. Leave it out of " + where + "." + WHY;
  if (kind === "handle") return "That looks like an @ name. Leave it out of " + where + "." + WHY;
  if (kind === "web") return "That looks like a web address. Leave it out of " + where + ", or put a space after the period." + WHY;
  return "That looks like a phone number. Leave long numbers out of " + where + "." + WHY;
}

const NAME_RULE = "A name can have letters, numbers, spaces and ' & - ! . in it. Take out anything else.";

// Reads an idea out of what the page sent. Returns { idea }, or { no: [code, words] } with
// the cause in words a child can read.
export function readIdea(body) {
  const no = (code, words) => ({ no: [code, words] });
  const { piece, color, print } = body;
  if (typeof piece !== "string" || !PIECES.includes(piece)) return no("no_such_piece", "We don't know that piece. Pick one from the design studio.");
  if (typeof color !== "string" || !COLORS.includes(color)) return no("no_such_color", "We don't know that color. Pick one of the twelve.");
  if (typeof print !== "string" || !(print === "none" || PRINTS.includes(print))) return no("no_such_print", "We don't know that print. Pick one from the design studio.");

  // The print's own color. With no print there is none, whatever the page sent.
  let ink = "";
  if (print !== "none") {
    if (body.ink == null || body.ink === "") return no("no_ink", "Pick a color for the print.");
    if (typeof body.ink !== "string" || !COLORS.includes(body.ink)) return no("no_such_ink", "We don't know that print color. Pick one of the twelve.");
    ink = body.ink;
  }

  // Her name for the design, such as "sunset flamingo". Kept in lowercase.
  let name = "";
  if (body.name != null) {
    if (typeof body.name !== "string") return no("bad_name", NAME_RULE);
    name = tidy(body.name).toLowerCase();
    const kind = gives(name);
    if (kind) return no("personal", leaveOut(kind, "the name"));
    if (name.length > MAX_NAME) return no("name_too_long", "That name is too long. Keep it to " + MAX_NAME + " letters or fewer.");
    if (name && !/^[\p{L}\p{M}\p{Nd} '&\-!.]+$/u.test(name)) return no("bad_name", NAME_RULE);
  }

  // Her answer to "what should we make next?".
  let note = "";
  if (body.note != null) {
    if (typeof body.note !== "string") return no("bad_note", "We couldn't read your note. Type it again.");
    note = tidy(body.note);
    const kind = gives(note);
    if (kind) return no("personal", leaveOut(kind, "your note"));
    if (note.length > MAX_NOTE) return no("note_too_long", "That note is too long. Keep it to " + MAX_NOTE + " letters or fewer.");
  }

  return { idea: { piece, color, print, ink, name, note } };
}

// ---- the store ------------------------------------------------------------------

// Where an idea is kept: idea/<piece>/<color>/<print>/<ink or "-">/<time>-<eight random hex>.
// Ideas with the same piece, color, print and ink share everything up to the last slash,
// so counting them is one listing.
export function comboOf(idea) {
  return "idea/" + [idea.piece, idea.color, idea.print, idea.ink || "-"].join("/") + "/";
}
export function stamp(at) {
  return at.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z") + "-" + randomBytes(4).toString("hex");
}

// The store for one request, or null when Netlify has given the function no Blobs
// environment. Opening it asks nobody.
//
// Netlify's client waits five seconds and tries again, up to five times, when the store
// does not answer or answers 429 or 500 and up. A shopper would watch that for half a
// minute. So the client is given its own fetch here. On the first failure the function is
// told at once, and the client's call is left waiting for good. It cannot try again, so an
// idea is never kept after she was told it was not.
//
// The client's "only if new" writes are not used: for those it reports every answer but
// 412 as a success.
//
// The store is asked for its latest state, not a cached copy ("strong" consistency). The
// count of ideas, and how often a design has been sent, come from a listing, and a listing
// must hold what was sent a moment ago. On 11 October 2026 the cached listing on the
// preview was more than a minute behind a write.
export function openBox(name) {
  let tell;
  const failed = new Promise((_, reject) => {
    tell = reject;
  });
  failed.catch(() => {});
  const never = new Promise(() => {});
  const until = Date.now() + WAIT_MS;
  const stop = (status, slow, cause) => {
    const e = new Error(slow ? "no answer in time" : status ? "answered " + status : "no answer");
    e.name = "StoreTrouble";
    e.status = status;
    e.slow = slow;
    e.cause = cause;
    tell(e);
    return never;
  };
  const once = (input, init) => {
    const left = until - Date.now();
    if (left <= 0) return stop(0, true);
    return fetch(input, { ...init, signal: AbortSignal.timeout(left) }).then(
      (res) => {
        if (res.status !== 429 && res.status < 500) return res;
        if (res.body) res.body.cancel().catch(() => {});
        return stop(res.status, false);
      },
      (e) => stop(0, !!e && (e.name === "TimeoutError" || e.name === "AbortError"), e),
    );
  };

  let store;
  try {
    store = getStore({ name, fetch: once, consistency: "strong" });
  } catch (e) {
    if (e && e.name === "MissingBlobsEnvironmentError") return null;
    throw e;
  }
  const ask = (work) => Promise.race([work, failed]);
  return {
    // Every key that starts with `prefix`.
    keys: async (prefix) => (await ask(store.list({ prefix }))).blobs.map((b) => b.key),
    put: (key, value) => ask(store.setJSON(key, value)),
    text: (key) => ask(store.get(key)),
    remove: (key) => ask(store.delete(key)),
  };
}

// The store failed. Returns [http status, code, words for her, may it pass on its own?,
// the cause for the check].
export function boxTrouble(e) {
  const status = e && typeof e.status === "number" ? e.status : 0;
  if (e && e.slow) {
    return [504, "box_slow", "The idea box took too long to answer. Try again.", true, "the store took too long to answer"];
  }
  if (e && e.name === "StoreTrouble" && !status) {
    return [502, "box_unreachable", "We couldn't reach the idea box. Try again in a minute.", true, "the store could not be reached"];
  }
  if (status === 401 || status === 403) {
    return [502, "box_refused", "The idea box isn't working right now. That's on us, not you.", false, "Netlify turned the function away from the store (" + status + ")"];
  }
  if (status === 429) {
    return [503, "busy", "The idea box is busy right now. Wait a minute and try again.", true, "the store is busy (429)"];
  }
  if (status >= 500) {
    return [502, "box_error", "The idea box had a problem. Try again in a minute.", true, "the store had a problem (" + status + ")"];
  }
  return [502, "box_error", "The idea box gave an answer we didn't expect. Try again later.", false, "the store gave an answer nobody expected" + (status ? " (" + status + ")" : "")];
}

// A failure, made safe to log. It holds the kind of error, and the store's own status and
// request id when it gave one. It never holds the body of an answer, and never the words
// of an error from anywhere else: those can repeat what was sent.
export function about(e) {
  if (!e) return "";
  if (e.name === "StoreTrouble") {
    const c = e.cause || {};
    return [e.message, c.name, c.code, c.cause && c.cause.code].filter(Boolean).join(" ");
  }
  if (e.name === "BlobsInternalError") {
    const said = String(e.message || "");
    return e.responseBody ? said.split(String(e.responseBody)).join("<body>") : said;
  }
  return String(e.name || "error");
}

export function log(where, code, detail) {
  console.error("[ideas] " + where + ": " + code + (detail ? " | " + clip(detail) : ""));
}
