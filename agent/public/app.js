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
  author: document.getElementById("author"),
  run: document.getElementById("run"),
  stop: document.getElementById("stop"),
  runStatus: document.getElementById("run-status"),
  spend: document.getElementById("spend"),
  spendText: document.getElementById("spend-text"),
  meterFill: document.getElementById("meter-fill"),
  meterText: document.getElementById("meter-text"),
  activity: document.getElementById("activity"),
  planPanel: document.getElementById("plan-panel"),
  planBody: document.getElementById("plan-body"),
  planNote: document.getElementById("plan-note"),
  planStatus: document.getElementById("plan-status"),
  approve: document.getElementById("approve"),
  reject: document.getElementById("reject"),
  grantPanel: document.getElementById("grant-panel"),
  grantSummary: document.getElementById("grant-summary"),
  grantLink: document.getElementById("grant-link"),
  memoryPanel: document.getElementById("memory-panel"),
  memoryDetails: document.getElementById("memory-details"),
  memoryCount: document.getElementById("memory-count"),
  memoryList: document.getElementById("memory-list"),
  memoryStatus: document.getElementById("memory-status"),
};

// Why a run ended, for the reasons that are not "it finished". Named here so
// that adding one to the script is not a silent change to what this page says:
// an unlisted reason reads as "Done.", which is the wrong word for a stop.
const STOP_REASONS = ["error", "step-limit", "history-limit", "cancelled"];

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

// Whether the run on screen is still working. It decides what the button
// does and what the prompt box means, so it is one flag rather than a guess
// made separately in each place.
let runWorking = false;

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

/**
 * Reflect whether the run is working.
 *
 * While it is, the prompt box sends into the run rather than starting a new
 * one, and there is a way to stop it — which there was not, and the run no
 * longer belongs to the tab, so nothing else would have.
 */
function setWorking(working) {
  runWorking = working;
  el.stop.hidden = !working;
  el.run.textContent = working ? "Send" : "Run";
  el.prompt.placeholder = working
    ? "Say something to the run in progress..."
    : "Ask for something...";
}

/**
 * Show or clear the plan a run is suspended on.
 *
 * The panel is the only part of this page that is waiting for the person
 * rather than reporting to them, so it is shown and hidden on its own rather
 * than folded into `setWorking` — a suspended run is still a working run as
 * far as the stop button and the prompt box are concerned, and conflating the
 * two would take away the ability to stop a run that is waiting.
 */
function showPlan(body) {
  el.planBody.textContent = body;
  el.planNote.value = "";
  setStatus(el.planStatus, "");
  el.approve.disabled = false;
  el.reject.disabled = false;
  el.planPanel.hidden = false;
  // "Working. You can close this page." is true of a run taking turns and
  // false of one that has stopped to ask — and closing the page while it
  // waits is exactly how nobody answers it.
  setStatus(el.runStatus, "Waiting for your answer.");
}

function hidePlan() {
  el.planPanel.hidden = true;
}

/**
 * Answer it.
 *
 * Both buttons go to one endpoint with the decision as a value, rather than
 * one endpoint each: they are the same act with a different answer, and the
 * note travels with either — a rejection that cannot say why teaches the model
 * one bit, and the next plan is a guess.
 */
async function decide(decision) {
  if (!shownRun) return;
  el.approve.disabled = true;
  el.reject.disabled = true;
  setStatus(
    el.planStatus,
    decision === "approve" ? "Approving..." : "Rejecting...",
  );
  try {
    await api("/agent/decide", {
      method: "POST",
      body: JSON.stringify({
        runId: shownRun,
        decision: decision,
        note: el.planNote.value.trim(),
      }),
    });
    // What happens next arrives on the stream, the same as every other turn,
    // and so does the decision itself — which is what updates a second tab
    // that was showing the same plan.
    hidePlan();
  } catch (e) {
    setStatus(el.planStatus, e.message, true);
    el.approve.disabled = false;
    el.reject.disabled = false;
  }
}

el.approve.addEventListener("click", () => decide("approve"));
el.reject.addEventListener("click", () => decide("reject"));

// ---------------------------------------------------------------------------
// What the agent believes about you
// ---------------------------------------------------------------------------

/**
 * Load the notes and render them.
 *
 * Reloaded after every run rather than patched as activity arrives. A run can
 * write a note, correct one, or be told to forget one, and reconciling each of
 * those against what is on screen would be a second implementation of the
 * store — the same mistake the page already avoided by not running the turn
 * loop itself. One read is cheaper than being subtly wrong.
 */
async function loadMemories() {
  let data;
  try {
    data = await api("/agent/memories");
  } catch (e) {
    // Signed out, or the endpoint is older than this page. Neither is worth
    // an error where the notes would be: the rest of the page still works.
    el.memoryPanel.hidden = true;
    return;
  }

  const memories = data.memories ?? [];
  el.memoryPanel.hidden = false;
  el.memoryCount.textContent =
    memories.length === 0
      ? "Nothing remembered yet"
      : memories.length === 1
        ? "1 note about you"
        : `${memories.length} notes about you`;

  el.memoryList.replaceChildren(...memories.map(memoryNode));
  setStatus(
    el.memoryStatus,
    data.more > 0 ? `${data.more} more not shown.` : "",
  );
}

function memoryNode(memory) {
  const li = document.createElement("li");
  li.className = "memory-item";

  const key = document.createElement("label");
  key.className = "memory-key";
  key.textContent = memory.key;

  const value = document.createElement("textarea");
  value.className = "memory-value";
  value.value = memory.value;
  // A field showing part of a note would save back part of a note, so a
  // truncated one is readable and not editable. Deleting it is still offered:
  // wanting it gone does not require being able to see all of it.
  value.disabled = Boolean(memory.truncated);

  const actions = document.createElement("div");
  actions.className = "memory-actions";

  const save = document.createElement("button");
  save.textContent = "Save";
  save.disabled = Boolean(memory.truncated);
  save.addEventListener("click", () =>
    saveMemory(memory.key, value.value, save),
  );

  const forget = document.createElement("button");
  forget.className = "aw-button--secondary";
  forget.textContent = "Delete";
  forget.addEventListener("click", () => forgetMemory(memory.key, forget));

  actions.append(save, forget);
  if (memory.truncated) {
    const why = document.createElement("span");
    why.className = "memory-note";
    why.textContent = `Too long to edit here (${memory.chars} characters).`;
    actions.append(why);
  }

  li.append(key, value, actions);
  return li;
}

async function saveMemory(key, value, button) {
  button.disabled = true;
  setStatus(el.memoryStatus, "Saving...");
  try {
    await api("/agent/memories", {
      method: "POST",
      body: JSON.stringify({ key, value }),
    });
    setStatus(el.memoryStatus, `Saved "${key}".`);
  } catch (e) {
    setStatus(el.memoryStatus, e.message, true);
  } finally {
    button.disabled = false;
  }
}

async function forgetMemory(key, button) {
  button.disabled = true;
  setStatus(el.memoryStatus, "Deleting...");
  try {
    await api(`/agent/memories?key=${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
    // Reloaded rather than removing the row here, so what is on screen is
    // what is stored rather than what this page believes it just did.
    await loadMemories();
    setStatus(el.memoryStatus, `Deleted "${key}".`);
  } catch (e) {
    setStatus(el.memoryStatus, e.message, true);
    button.disabled = false;
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
  link.className = "aw-button aw-button--small";
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
  setStatus(el.runStatus, runWorking ? "Sending..." : "Starting...");

  try {
    if (runWorking) {
      // Into the run rather than alongside it. It lands at the next turn
      // boundary, which is the soonest the model can be told anything
      // without it arriving in the middle of a decision.
      try {
        await api("/agent/say", {
          method: "POST",
          body: JSON.stringify({ runId: shownRun, text: prompt }),
        });
        el.prompt.value = "";
        setStatus(el.runStatus, "Sent. It lands at the next turn.");
        return;
      } catch (e) {
        // It finished between typing and sending. Not a failure — the words
        // are still wanted, so they start a run instead.
        if (!e.body?.runEnded) throw e;
        setWorking(false);
      }
    }

    await api("/agent/prompt", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        kind: el.author && el.author.checked ? "author" : "chat",
      }),
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
    } else if (e.body?.needsAuthority) {
      setStatus(el.runStatus, e.message, true);
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

el.stop.addEventListener("click", async () => {
  if (!shownRun) return;
  el.stop.disabled = true;
  try {
    await api("/agent/cancel", {
      method: "POST",
      body: JSON.stringify({ runId: shownRun }),
    });
    // The rest arrives on the stream like any other end of a run, so there is
    // nothing to render here — and a second tab watching the same run learns
    // about it the same way.
  } catch (e) {
    setStatus(el.runStatus, e.message, true);
  } finally {
    el.stop.disabled = false;
  }
});

/**
 * The agent needs the person's permission to work while they are away.
 *
 * Not an error state: they have simply not been asked yet, or the grant has
 * lapsed. The engine's consent page says what is being asked for and sends
 * them back here.
 */
/**
 * What this agent is allowed to do as this person, and the way to change it.
 *
 * Shown whether or not anything is granted, which is the point of it. The
 * first-run prompt below covers "you have not been asked yet"; this covers
 * every case after that — widening a grant so the agent can manage scripts
 * and users, narrowing one, or taking it back — none of which had anywhere to
 * be reached from.
 *
 * The consent URL is the engine's, handed over by the server rather than
 * built here: it names this script, and a page guessing at its own URI is a
 * page that gets it wrong the first time the script is renamed.
 */
function showGrant(auth) {
  if (!auth || !auth.authenticated || !auth.consentUrl) {
    el.grantPanel.hidden = true;
    return;
  }

  el.grantPanel.hidden = false;
  el.grantLink.href =
    auth.consentUrl + "&redirect=" + encodeURIComponent("/agent");

  if (!auth.granted) {
    el.grantSummary.textContent = auth.expired
      ? "Your permission has expired, so runs cannot start."
      : "This agent has no permission to work while you are away yet.";
    el.grantLink.textContent = "Give permission";
    return;
  }

  // What was actually ticked, rather than a guess. The engine hands the
  // scopes back with the grant, so the page can say which of them are on
  // instead of describing the ones it assumes.
  const granted = auth.scopes ?? [];
  const manages =
    granted.indexOf("administer") !== -1 || granted.indexOf("author") !== -1;

  el.grantSummary.textContent =
    "On: " +
    granted.map(scopeLabel).join(", ") +
    ". " +
    (manages
      ? "It can manage this engine as you, so it can answer questions about scripts and users."
      : "To let it manage scripts and users \u2014 listing users, reading and writing scripts \u2014 add \u201cadminister\u201d or \u201cauthor\u201d.") +
    " Changes apply to the next run you start.";
  el.grantLink.textContent = "Change permissions";
}

/** A scope as the consent page words it, so the two pages agree. */
function scopeLabel(scope) {
  switch (scope) {
    case "personal_storage":
      return "your notes";
    case "secrets":
      return "your API key";
    case "write":
      return "changing things";
    case "author":
      return "authoring your scripts";
    case "administer":
      return "administering this engine";
    default:
      return scope;
  }
}

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

    // A run started before this page was opened is still a run: it can be
    // stopped and spoken to from here, which is the point of it not belonging
    // to the tab.
    const state = history.runState ?? "done";
    setWorking(state === "running" || state === "waiting");
    // A run suspended before this page was opened is still asking. Without
    // this the panel only ever appeared for whoever happened to be watching
    // when the plan landed.
    if (state === "waiting" && history.pendingPlan) {
      showPlan(history.pendingPlan.body);
    }
    if (runWorking)
      setStatus(el.runStatus, "Working. You can close this page.");

    loadMemories();

    // Say up front that a run will need permission, rather than letting them
    // write a prompt and meet the refusal afterwards.
    const auth = history.authorization;
    showGrant(auth);
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

      // What the turn just cost. Carries numbers rather than text, so it is
      // the one message that is not an activity and must never become a row.
      if (payload.kind === "spend") {
        if (payload.spend) {
          if (payload.runId !== shownRun) {
            // A run this page has not been following — another tab started
            // it. Its totals are not ours to add to.
            shownRun = payload.runId;
            spend = EMPTY_SPEND;
          }
          spend = addSpend(spend || EMPTY_SPEND, payload.spend);
          renderSpend();
        }
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
        // Another tab may have started it. Either way there is now a run to
        // stop and a run to speak into.
        setWorking(true);
      }

      // A run has suspended and is asking. Rendered as a panel as well as an
      // activity row: the row is the record of what was proposed, the panel is
      // the thing that can be answered.
      if (payload.kind === "plan") {
        shownRun = payload.runId;
        showPlan(payload.message);
      }

      // Someone answered — this tab or another one. Either way the question
      // is gone, which is what keeps two open tabs from both offering to
      // decide something already decided.
      if (payload.kind === "decision") {
        hidePlan();
      }

      // The end of a run is an activity like any other now. It used to be the
      // reply to the step the page was waiting on, and there is nothing to
      // wait on any more.
      if (payload.kind === "done") {
        hidePlan();
        // A run that just finished may have written, corrected or removed a
        // note. Re-read rather than guess from the activity that went past.
        loadMemories();
        if (wasPending) render();
        setWorking(false);
        const stopped = STOP_REASONS.indexOf(payload.message) !== -1;
        setStatus(
          el.runStatus,
          payload.message === "cancelled"
            ? "Stopped."
            : stopped
              ? "Stopped."
              : "Done.",
          stopped,
        );
        return;
      }

      addEntry(payload);
    } catch {
      // Keep-alives and anything else the engine sends are not activity.
    }
  });
}

start();
