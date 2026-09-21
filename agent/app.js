// The page.
//
// It watches; it does not drive. Posting a prompt queues the run in the engine
// and returns, and every turn after that is queued by the one before it — so
// this page's only job is to render what arrives on the SSE stream, and a run
// goes on whether or not anybody is looking at it.
//
// It used to be the other half of the loop, posting one step per turn, because
// the engine had nowhere to run a turn except inside a request from the person
// it belonged to. That is no longer true, and the loop that was here is gone
// rather than kept as a fallback: two ways to advance the same run is how they
// drift apart.
//
// Two kinds of message arrive on that stream. An activity is a row that was
// stored, and it is the record. A delta is a piece of an answer still being
// written, stored nowhere — so it is rendered as a provisional entry and
// replaced the moment the real row for it lands.

const el = {
  keyPanel: document.getElementById("key-panel"),
  key: document.getElementById("key"),
  saveKey: document.getElementById("save-key"),
  forgetKey: document.getElementById("forget-key"),
  keyStatus: document.getElementById("key-status"),
  prompt: document.getElementById("prompt"),
  run: document.getElementById("run"),
  runStatus: document.getElementById("run-status"),
  spend: document.getElementById("spend"),
  spendText: document.getElementById("spend-text"),
  meterFill: document.getElementById("meter-fill"),
  meterText: document.getElementById("meter-text"),
  activity: document.getElementById("activity"),
};

// Why a run ended, for the reasons that are not "it finished". Named here so
// that adding one to the script is not a silent change to what this page says:
// an unlisted reason reads as "Done.", which is the wrong word for a stop.
const STOP_REASONS = ["error", "step-limit", "history-limit"];

let entries = [];
let running = false;

// The answer currently being written, if one is.
//
// One string rather than a map keyed by run, because at most one block streams
// at a time: the API finishes a content block before starting the next, and a
// person's runs no longer overlap — the engine's queue gives every personal
// task a lane and defaults it to the person, so two prompts wait for each
// other instead of interleaving.
let pending = "";

// What the run on screen has cost. Loaded whole with the history, then added
// to as each turn lands — the totals are the script's, not this page's
// arithmetic on something it might have missed.
let spend = null;
let pricing = null;
let contextWindow = 0;
let shownRun = "";

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  const nodes = entries.map((entry) => entryNode(entry, false));
  if (pending) {
    nodes.push(entryNode({ kind: "writing", message: pending }, true));
  }
  if (nodes.length === 0) {
    el.activity.innerHTML = '<li class="empty">Nothing yet.</li>';
    return;
  }
  el.activity.replaceChildren(...nodes);
  el.activity.lastElementChild?.scrollIntoView({ block: "nearest" });
}

// `live` marks the one entry that is still being written, which is what earns
// it a caret. Everything else about it is an ordinary row, because it is about
// to become one.
function entryNode(entry, live) {
  const li = document.createElement("li");
  if (live) li.className = "live";
  const kind = document.createElement("span");
  kind.className = "kind";
  kind.dataset.kind = entry.kind;
  kind.textContent = entry.kind;
  const message = document.createElement("p");
  message.className = "message";
  message.textContent = entry.message;
  li.append(kind, message);
  return li;
}

function addEntry(entry) {
  entries.push(entry);
  render();
}

// ---------------------------------------------------------------------------
// What it cost
// ---------------------------------------------------------------------------

const EMPTY_SPEND = {
  turns: 0,
  cached: 0,
  wrote: 0,
  fresh: 0,
  output: 0,
  largestPrompt: 0,
};

function addSpend(into, delta) {
  return {
    turns: into.turns + (delta.turns || 0),
    cached: into.cached + (delta.cached || 0),
    wrote: into.wrote + (delta.wrote || 0),
    fresh: into.fresh + (delta.fresh || 0),
    output: into.output + (delta.output || 0),
    largestPrompt: Math.max(into.largestPrompt, delta.largestPrompt || 0),
  };
}

// Dollars, at the rates the script costed the model with. Approximate on
// purpose and labelled as such: it is the right order of magnitude for
// somebody deciding whether to keep going, and it is not an invoice.
function estimateCost(s) {
  if (!pricing) return null;
  return (
    (s.fresh * pricing.freshPerM +
      s.wrote * pricing.cacheWritePerM +
      s.cached * pricing.cacheReadPerM +
      s.output * pricing.outputPerM) /
    1000000
  );
}

function money(amount) {
  if (amount >= 0.01) return "$" + amount.toFixed(2);
  if (amount > 0) return "<$0.01";
  return "$0.00";
}

function thousands(n) {
  return n.toLocaleString();
}

function renderSpend() {
  if (!spend || spend.turns === 0) {
    el.spend.hidden = true;
    return;
  }
  el.spend.hidden = false;

  const promptTokens = spend.cached + spend.wrote + spend.fresh;
  const parts = [
    spend.turns === 1 ? "1 turn" : spend.turns + " turns",
    thousands(promptTokens) + " in",
    thousands(spend.output) + " out",
  ];
  // Only worth saying when it happened. Below the model's minimum cacheable
  // prefix nothing is cached, and a permanent "0 from cache" would read as a
  // fault rather than as a short run.
  if (spend.cached > 0) {
    const saved = Math.round((spend.cached / promptTokens) * 100);
    parts.push(thousands(spend.cached) + " from cache (" + saved + "%)");
  }
  const cost = estimateCost(spend);
  if (cost !== null) parts.push("≈ " + money(cost));
  el.spendText.textContent = parts.join(" · ");

  if (contextWindow > 0) {
    const used = Math.min(spend.largestPrompt / contextWindow, 1);
    el.meterFill.style.width = (used * 100).toFixed(1) + "%";
    el.meterText.textContent =
      thousands(spend.largestPrompt) +
      " / " +
      thousands(contextWindow) +
      " context";
  }
}

function setStatus(node, text, isError) {
  node.textContent = text;
  node.classList.toggle("error", Boolean(isError));
}

/**
 * A message with something to click on the end of it.
 *
 * For the cases where saying what is wrong is not enough, because fixing it
 * means going somewhere: signing in, or granting the agent permission. The
 * page used to name the path in prose and leave the person to type it.
 *
 * Built rather than assigned as HTML: `label` and `href` end up as text and an
 * attribute, so nothing here can turn a message into markup.
 */
function setStatusWithAction(node, text, label, href, isError) {
  node.textContent = text;
  node.classList.toggle("error", Boolean(isError));
  const link = document.createElement("a");
  link.className = "action";
  link.href = href;
  link.textContent = label;
  node.appendChild(link);
}

/** Where to send somebody to sign in and be returned to this page. */
function signInUrl() {
  return (
    "/auth/login?redirect=" +
    encodeURIComponent(location.pathname + location.search)
  );
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function api(path, options) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    // A non-JSON body means something other than this API answered.
  }
  if (!response.ok) {
    const error = new Error(describe(body, response.status));
    error.status = response.status;
    error.body = body;
    error.requestId = body.error?.request_id;
    throw error;
  }
  return body;
}

// Two error shapes reach here. This script answers `{error: "some text"}`; the
// engine answers its own envelope, `{error: {code, message, request_id, ...}}`
// — and reading that one as a string is how a stopped handler reported itself
// as "[object Object]".
function describe(body, status) {
  const error = body?.error;
  if (typeof error === "string") return error;
  if (error && typeof error.message === "string") {
    return error.request_id
      ? `${error.message} (request ${error.request_id})`
      : error.message;
  }
  return `Request failed (${status})`;
}

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

function showKeyState(hasKey) {
  el.keyPanel.hidden = false;
  el.forgetKey.hidden = !hasKey;
  el.key.value = "";
  el.key.placeholder = hasKey ? "A key is stored" : "sk-ant-...";
  setStatus(el.keyStatus, hasKey ? "Key stored." : "No key stored yet.");
}

el.saveKey.addEventListener("click", async () => {
  const key = el.key.value.trim();
  if (!key) {
    setStatus(el.keyStatus, "Paste a key first.", true);
    return;
  }
  el.saveKey.disabled = true;
  try {
    const result = await api("/agent/key", {
      method: "POST",
      body: JSON.stringify({ key }),
    });
    showKeyState(result.hasKey);
  } catch (e) {
    setStatus(el.keyStatus, e.message, true);
  } finally {
    el.saveKey.disabled = false;
  }
});

el.forgetKey.addEventListener("click", async () => {
  el.forgetKey.disabled = true;
  try {
    const result = await api("/agent/key", { method: "DELETE" });
    showKeyState(result.hasKey);
  } catch (e) {
    setStatus(el.keyStatus, e.message, true);
  } finally {
    el.forgetKey.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

el.run.addEventListener("click", async () => {
  const prompt = el.prompt.value.trim();
  if (!prompt || running) return;

  running = true;
  el.run.disabled = true;
  setStatus(el.runStatus, "Starting...");

  try {
    await api("/agent/prompt", {
      method: "POST",
      body: JSON.stringify({ prompt }),
    });
    el.prompt.value = "";
    // The engine has it now. Everything from here — each turn, each tool, the
    // end of the run — arrives on the stream, the same way it arrives in any
    // other tab this person has open.
    setStatus(el.runStatus, "Working. You can close this page.");
  } catch (e) {
    if (e.status === 401) {
      setStatusWithAction(
        el.runStatus,
        "You have been signed out.",
        "Sign in",
        signInUrl(),
        true,
      );
    } else if (e.body?.needsAuthorization) {
      showAuthorizationNeeded(e.body);
    } else if (e.body?.needsKey) {
      setStatus(el.runStatus, e.message, true);
      showKeyState(false);
    } else {
      setStatus(el.runStatus, e.message, true);
    }
  } finally {
    running = false;
    el.run.disabled = false;
  }
});

/**
 * The agent needs the person's permission to work while they are away.
 *
 * Not an error state: they have simply not been asked yet, or the grant has
 * lapsed. The engine's consent page says what is being asked for and sends
 * them back here.
 */
function showAuthorizationNeeded(body) {
  setStatusWithAction(
    el.runStatus,
    body.error,
    "Give permission",
    body.consentUrl + "&redirect=" + encodeURIComponent("/agent"),
    false,
  );
}

el.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    el.run.click();
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function start() {
  try {
    const history = await api("/agent/history");
    entries = history.activities ?? [];
    render();
    showKeyState(history.hasKey);

    pricing = history.pricing ?? null;
    contextWindow = history.contextWindow ?? 0;
    shownRun = history.runId ?? "";
    spend = history.spend ?? EMPTY_SPEND;
    renderSpend();

    // Say up front that a run will need permission, rather than letting them
    // write a prompt and meet the refusal afterwards.
    const auth = history.authorization;
    if (auth && auth.authenticated && !auth.granted) {
      showAuthorizationNeeded({
        error: auth.expired
          ? "Your permission for this agent has expired."
          : "This agent needs your permission to work while you are away.",
        consentUrl: auth.consentUrl,
      });
    }
  } catch (e) {
    if (e.status === 401) {
      setStatusWithAction(
        el.runStatus,
        "Sign in to use the agent.",
        "Sign in",
        signInUrl(),
        true,
      );
      // The key form is no use signed out either, and leaving it there invites
      // somebody to paste a key that has nowhere to go.
      el.keyPanel.hidden = true;
      el.run.disabled = true;
      el.prompt.disabled = true;
      return;
    }
    setStatus(el.runStatus, e.message, true);
  }

  // Everything arrives here: this page's runs, another tab's, and the turns of
  // a run that was started before this page was opened at all.
  const events = new EventSource("/agent/events");
  events.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (!payload || typeof payload.message !== "string") return;

      // A piece of the answer, still being written. These are the only
      // messages the script sends without storing anything, so they are the
      // only ones that do not correspond to a row.
      if (payload.kind === "delta") {
        pending += payload.message;
        render();
        return;
      }

      // Anything the run recorded supersedes what was being written: the table
      // is the record and the deltas were a preview of it. Clearing here
      // rather than on a particular kind is what stops a half-streamed answer
      // outliving the turn that was writing it.
      const wasPending = pending !== "";
      pending = "";

      // A new run starts its own tally. Keyed on the prompt rather than on
      // the run id changing, so a stray message from an older run cannot
      // reset what is on screen.
      if (payload.kind === "prompt") {
        shownRun = payload.runId;
        spend = EMPTY_SPEND;
        renderSpend();
      }

      // The end of a run is an activity like any other now. It used to be the
      // reply to the step the page was waiting on, and there is nothing to
      // wait on any more.
      if (payload.kind === "done") {
        if (wasPending) render();
        const stopped = STOP_REASONS.indexOf(payload.message) !== -1;
        setStatus(el.runStatus, stopped ? "Stopped." : "Done.", stopped);
        return;
      }

      addEntry(payload);
    } catch {
      // Keep-alives and anything else the engine sends are not activity.
    }
  });
}

start();
