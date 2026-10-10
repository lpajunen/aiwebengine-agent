// The page.
//
// It watches; it does not drive. Posting a prompt queues the run in the engine
// and returns, and every turn after that is queued by the one before it — so
// this page's only job is to render what arrives on the SSE stream, and a run
// goes on whether or not anybody is looking at it.
//
// There is deliberately no second way to advance a run from here: two ways to
// advance the same run is how they drift apart.
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
  commandMenu: document.getElementById("command-menu"),
  author: document.getElementById("author"),
  talk: document.getElementById("talk"),
  attach: document.getElementById("attach"),
  fileInput: document.getElementById("file-input"),
  attachments: document.getElementById("attachments"),
  promptSection: document.getElementById("prompt-section"),
  speak: document.getElementById("speak"),
  speakChoice: document.getElementById("speak-choice"),
  run: document.getElementById("run"),
  newConversation: document.getElementById("new-conversation"),
  stop: document.getElementById("stop"),
  runStatus: document.getElementById("run-status"),
  spend: document.getElementById("spend"),
  spendText: document.getElementById("spend-text"),
  meterFill: document.getElementById("meter-fill"),
  meterText: document.getElementById("meter-text"),
  activity: document.getElementById("activity"),
  conversationsDetails: document.getElementById("conversations-details"),
  conversationsCount: document.getElementById("conversations-count"),
  conversationsList: document.getElementById("conversations-list"),
  olderConversations: document.getElementById("older-conversations"),
  conversationsStatus: document.getElementById("conversations-status"),
  planPanel: document.getElementById("plan-panel"),
  planBody: document.getElementById("plan-body"),
  planNote: document.getElementById("plan-note"),
  planStatus: document.getElementById("plan-status"),
  approve: document.getElementById("approve"),
  reject: document.getElementById("reject"),
  openKey: document.getElementById("open-key"),
  grantLink: document.getElementById("grant-link"),
  inspectLink: document.getElementById("inspect-link"),
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
// person's runs do not overlap — the engine's queue gives every personal
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
// Whether the conversation on screen has messages, which is what makes the
// next Run a continuation and fixes what the conversation is for.
let hasConversation = false;

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
  const pictures = Array.isArray(entry.detail)
    ? entry.detail.filter((d) => d && d.preview && d.id)
    : [];
  if (pictures.length > 0) {
    // The agent's copy of each picture, at log size; the full one opens on
    // its own.
    const strip = document.createElement("span");
    strip.className = "thumbs";
    for (const picture of pictures) {
      const url = "/agent/attachment?id=" + encodeURIComponent(picture.id);
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      const img = document.createElement("img");
      img.src = url;
      img.alt = picture.name;
      img.loading = "lazy";
      link.append(img);
      strip.append(link);
    }
    message.append(strip);
  }
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
  // A boundary under a working run would leave it speaking into a
  // conversation that is no longer on screen.
  el.newConversation.disabled = working;
  // Files go with a prompt that starts a turn, not into one under way.
  el.attach.disabled = working;
  renderConversationMarks();
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
 * means going somewhere: signing in, or granting the agent permission.
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
  // A form names its own Content-Type, with the boundary in it.
  const isForm = options?.body instanceof FormData;
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(isForm ? {} : { "content-type": "application/json" }),
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

// Whether the person asked for the key form from the menu. With no key stored
// the form is shown regardless: the agent cannot run without one.
let keyFormOpen = false;
let keyStored = false;

function showKeyState(hasKey) {
  keyStored = hasKey;
  el.keyPanel.hidden = hasKey && !keyFormOpen;
  el.forgetKey.hidden = !hasKey;
  el.key.value = "";
  el.key.placeholder = hasKey ? "A key is stored" : "sk-ant-...";
  setStatus(el.keyStatus, hasKey ? "Key stored." : "No key stored yet.");
}

// Opens on the conversation this page shows, not merely the newest.
el.inspectLink.addEventListener("click", () => {
  el.inspectLink.href =
    "/agent/inspect" +
    (shownRun ? "?runId=" + encodeURIComponent(shownRun) : "");
});

el.openKey.addEventListener("click", () => {
  keyFormOpen = !(keyStored && !el.keyPanel.hidden);
  showKeyState(keyStored);
  if (!el.keyPanel.hidden) el.key.focus();
});

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
// The conversation
// ---------------------------------------------------------------------------

/**
 * A conversation that has begun is for one thing: the tools its history names
 * do not change under it, so the build-a-script box shows what it was started
 * with and cannot be flipped until there is a new conversation.
 */
function showConversation(has, kind) {
  hasConversation = Boolean(has);
  if (!el.author) return;
  if (hasConversation) el.author.checked = kind === "author";
  el.author.disabled = hasConversation;
}

/** An empty conversation on screen, the id the script handed out for it. */
function showFreshConversation(runId) {
  shownRun = runId;
  entries = [];
  pending = "";
  spend = EMPTY_SPEND;
  renderSpend();
  hidePlan();
  showConversation(false, "chat");
  render();
  renderConversationMarks();
  el.prompt.value = "";
  setStatus(el.runStatus, "");
  el.prompt.focus();
}

el.newConversation.addEventListener("click", async () => {
  if (runWorking || running) return;
  stopSpeaking();
  el.newConversation.disabled = true;
  try {
    const started = await api("/agent/new", { method: "POST", body: "{}" });
    showFreshConversation(started.runId);
  } catch (e) {
    if (e.body?.runLive) setWorking(true);
    setStatus(el.runStatus, e.message, true);
  } finally {
    el.newConversation.disabled = runWorking;
  }
});

// ---------------------------------------------------------------------------
// Earlier conversations
// ---------------------------------------------------------------------------

let conversations = [];
// The cursor for the next, older page, or null when the list is complete.
let conversationsNext = null;

async function loadConversations() {
  try {
    const answer = await api("/agent/conversations");
    conversations = answer.conversations ?? [];
    conversationsNext = answer.next ?? null;
    renderConversations();
  } catch {
    // The list is a convenience; the page works without it.
  }
}

el.olderConversations.addEventListener("click", async () => {
  if (conversationsNext === null) return;
  el.olderConversations.disabled = true;
  try {
    const answer = await api(
      "/agent/conversations?before=" + encodeURIComponent(conversationsNext),
    );
    // A conversation that became active while the list was open moved to
    // the top; it is not shown twice.
    const shown = new Set(conversations.map((c) => c.runId));
    conversations = conversations.concat(
      (answer.conversations ?? []).filter((c) => !shown.has(c.runId)),
    );
    conversationsNext = answer.next ?? null;
    renderConversations();
  } catch (e) {
    setStatus(el.conversationsStatus, e.message, true);
  } finally {
    el.olderConversations.disabled = false;
  }
});

function renderConversations() {
  el.conversationsCount.textContent =
    conversations.length === 0
      ? "Conversations"
      : "Conversations (" +
        conversations.length +
        (conversationsNext === null ? "" : "+") +
        ")";
  el.olderConversations.hidden = conversationsNext === null;
  const rows = conversations.map((c) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation-item";
    button.dataset.runId = c.runId;
    const title = document.createElement("span");
    title.className = "conversation-title";
    title.textContent = c.title || "(no prompt)";
    const when = document.createElement("span");
    when.className = "conversation-when";
    when.textContent =
      (c.state === "running" || c.state === "waiting"
        ? "working \u00b7 "
        : "") + new Date(c.at).toLocaleString();
    button.append(title, when);
    button.addEventListener("click", () => openConversation(c.runId));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "conversation-delete aw-button--secondary";
    remove.dataset.runId = c.runId;
    remove.textContent = "Delete";
    remove.setAttribute("aria-label", "Delete " + (c.title || "conversation"));
    remove.addEventListener("click", () => deleteConversation(c, remove));

    const li = document.createElement("li");
    li.append(button, remove);
    return li;
  });
  el.conversationsList.replaceChildren(...rows);
  renderConversationMarks();
}

/**
 * Delete on the second press. The first arms the button for a few seconds,
 * which is enough of a question for something that cannot be undone without
 * a dialog that would stop the page.
 */
async function deleteConversation(c, button) {
  if (button.dataset.armed !== "true") {
    button.dataset.armed = "true";
    button.textContent = "Delete?";
    setTimeout(() => {
      button.dataset.armed = "false";
      button.textContent = "Delete";
    }, 4000);
    return;
  }
  button.disabled = true;
  try {
    const answer = await api("/agent/delete", {
      method: "POST",
      body: JSON.stringify({ runId: c.runId }),
    });
    conversations = conversations.filter((x) => x.runId !== c.runId);
    renderConversations();
    setStatus(
      el.conversationsStatus,
      answer.filesLeft > 0
        ? `Deleted. ${answer.filesLeft} attached file(s) could not be removed from your Anthropic storage.`
        : "Deleted.",
      answer.filesLeft > 0,
    );
    if (c.runId === shownRun) clearConversation();
  } catch (e) {
    button.disabled = false;
    setStatus(el.conversationsStatus, e.message, true);
  }
}

/** Show nothing: what a deleted conversation that was on screen leaves. */
function clearConversation() {
  shownRun = "";
  entries = [];
  pending = "";
  spend = EMPTY_SPEND;
  renderSpend();
  hidePlan();
  showConversation(false, "chat");
  render();
  renderConversationMarks();
}

// Which one is on screen, and whether switching is allowed: a working run is
// the conversation on screen, and moving away from it would leave its stop
// button and its plan pointing at something the page no longer shows.
function renderConversationMarks() {
  for (const button of el.conversationsList.querySelectorAll(
    ".conversation-item",
  )) {
    const current = button.dataset.runId === shownRun;
    if (current) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
    button.disabled = runWorking && !current;
  }
  // The conversation that is working cannot be deleted; the script would
  // refuse, and the button says so first.
  for (const button of el.conversationsList.querySelectorAll(
    ".conversation-delete",
  )) {
    button.disabled = runWorking && button.dataset.runId === shownRun;
  }
}

async function openConversation(runId) {
  if (runId === shownRun || runWorking || running) return;
  try {
    showHistory(await api("/agent/history?runId=" + encodeURIComponent(runId)));
    el.prompt.focus();
  } catch (e) {
    setStatus(el.runStatus, e.message, true);
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

el.run.addEventListener("click", async () => {
  // What is in the box is what was heard; a result still arriving would put
  // it back after the box is cleared.
  abortDictation();
  stopSpeaking();
  const prompt = el.prompt.value.trim();
  if ((!prompt && attachments.length === 0) || running) return;
  if (runWorking && attachments.length > 0) {
    setStatus(
      el.runStatus,
      "Files go with a new prompt. Wait for this run to finish, or stop it.",
      true,
    );
    return;
  }

  running = true;
  el.run.disabled = true;
  setStatus(el.runStatus, runWorking ? "Sending..." : "Starting...");

  try {
    if (runWorking) {
      // Into the run rather than alongside it. It lands at the next turn
      // boundary, which is the soonest the model can be told anything
      // without it arriving in the middle of a decision.
      try {
        const said = await api("/agent/say", {
          method: "POST",
          body: JSON.stringify({ runId: shownRun, text: prompt }),
        });
        el.prompt.value = "";
        // `/stop`, the Stop button typed. The stream's `done` may have landed
        // first, so this says the same rather than something earlier.
        if (said.stopped) {
          setStatus(el.runStatus, "Stopped.");
          return;
        }
        setStatus(el.runStatus, "Sent. It lands at the next turn.");
        return;
      } catch (e) {
        // It finished between typing and sending. Not a failure — the words
        // are still wanted, so they start a run instead.
        if (!e.body?.runEnded) throw e;
        setWorking(false);
      }
    }

    const fields = {
      prompt,
      kind: el.author && el.author.checked ? "author" : "chat",
      // The conversation on screen: its earlier messages are the context.
      // Empty after "New conversation" until this prompt starts it.
      runId: shownRun || undefined,
    };
    const started = await api("/agent/prompt", {
      method: "POST",
      body:
        attachments.length > 0
          ? attachmentForm(fields)
          : JSON.stringify(fields),
    });
    // `/new` on its own: the button, typed. No run was started.
    if (started.fresh) {
      showFreshConversation(started.runId);
      return;
    }
    el.prompt.value = "";
    clearAttachments();
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
    } else if (e.body?.runLive) {
      // Another tab started a turn. Say it into the run, not beside it.
      setWorking(true);
      setStatus(el.runStatus, e.message, true);
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
  stopSpeaking();
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
 * A "Permissions" item in the account menu, whose tooltip says what is on.
 * Always there once signed in, whether or not anything is granted, which is the
 * point of it. The first-run prompt below covers "you have not been asked yet"; this covers
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
    el.grantLink.hidden = true;
    return;
  }

  el.grantLink.hidden = false;
  el.grantLink.href =
    auth.consentUrl + "&redirect=" + encodeURIComponent("/agent");

  if (!auth.granted) {
    el.grantLink.title = auth.expired
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

  el.grantLink.title =
    "On: " +
    granted.map(scopeLabel).join(", ") +
    ". " +
    (manages
      ? "It can manage this engine as you, so it can answer questions about scripts and users."
      : "To let it manage scripts and users \u2014 listing users, reading and writing scripts \u2014 add \u201cadminister\u201d or \u201cauthor\u201d.") +
    (granted.indexOf("tools") !== -1
      ? " It can use your other apps' tools."
      : " To let it use your other apps, add \u201cUse your other apps' tools\u201d.") +
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
    case "tools":
      return "using your other apps";
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
  if (commandKey(event)) return;
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    el.run.click();
  }
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
//
// A prompt may begin with /new or /<skill>; the script reads the command. The
// box offers the names while the first word is being typed, from the same
// list Telegram's / menu shows.

let commands = [];
let commandMatches = [];
let commandActive = 0;
// Escape closes the menu until the word changes, not until the next key.
let commandDismissed = "";

async function loadCommands() {
  try {
    commands = (await api("/agent/commands")).commands ?? [];
  } catch {
    // Without the list the box is a plain box; a typed command still works.
    commands = [];
  }
  updateCommandMenu();
}

/** The `/word` the caret is in, if it is the prompt's first word. */
function commandWord() {
  const value = el.prompt.value;
  const caret = el.prompt.selectionStart;
  if (value[0] !== "/" || caret !== el.prompt.selectionEnd) return null;
  const match = /^\/[a-z0-9_-]*/i.exec(value);
  if (!match || caret > match[0].length) return null;
  return match[0];
}

function updateCommandMenu() {
  const word = commandWord();
  if (word === null || word === commandDismissed) {
    hideCommandMenu();
    return;
  }
  commandDismissed = "";
  // Telegram's spelling, release_notes, finds release-notes here too.
  const typed = word.slice(1).toLowerCase().replace(/_/g, "-");
  commandMatches = commands.filter((c) => c.name.indexOf(typed) === 0);
  // Fully typed, with nothing else it could become: nothing left to offer.
  if (
    commandMatches.length === 0 ||
    (commandMatches.length === 1 && commandMatches[0].name === typed)
  ) {
    hideCommandMenu();
    return;
  }
  commandActive = Math.min(commandActive, commandMatches.length - 1);
  renderCommandMenu();
}

function renderCommandMenu() {
  el.commandMenu.replaceChildren(
    ...commandMatches.map((command, i) => {
      const item = document.createElement("li");
      item.id = "command-" + i;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(i === commandActive));
      const name = document.createElement("span");
      name.className = "command-name";
      name.textContent = "/" + command.name;
      const description = document.createElement("span");
      description.className = "command-description";
      description.textContent = command.description;
      item.append(name, description);
      // On mousedown, before the box loses focus and closes the menu.
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        acceptCommand(i);
      });
      return item;
    }),
  );
  el.commandMenu.hidden = false;
  el.prompt.setAttribute("aria-expanded", "true");
  el.prompt.setAttribute("aria-activedescendant", "command-" + commandActive);
  el.commandMenu.children[commandActive]?.scrollIntoView({ block: "nearest" });
}

function hideCommandMenu() {
  commandMatches = [];
  commandActive = 0;
  el.commandMenu.hidden = true;
  el.prompt.setAttribute("aria-expanded", "false");
  el.prompt.removeAttribute("aria-activedescendant");
}

/** Put the chosen command in place of the word being typed. */
function acceptCommand(i) {
  const command = commandMatches[i];
  const word = commandWord();
  if (!command || word === null) return;
  const rest = el.prompt.value.slice(word.length).replace(/^\s*/, "");
  const head = "/" + command.name + " ";
  el.prompt.value = head + rest;
  el.prompt.setSelectionRange(head.length, head.length);
  hideCommandMenu();
  el.prompt.focus();
}

/** The menu's keys, while it is open. True when the key was the menu's. */
function commandKey(event) {
  if (el.commandMenu.hidden) return false;
  const count = commandMatches.length;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    commandActive =
      (commandActive + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
    renderCommandMenu();
  } else if (
    (event.key === "Enter" || event.key === "Tab") &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  ) {
    acceptCommand(commandActive);
  } else if (event.key === "Escape") {
    commandDismissed = commandWord() ?? "";
    hideCommandMenu();
  } else {
    return false;
  }
  event.preventDefault();
  return true;
}

el.prompt.addEventListener("input", () => {
  commandActive = 0;
  updateCommandMenu();
});
// The caret moving in or out of the first word, by click or arrow key.
el.prompt.addEventListener("click", updateCommandMenu);
el.prompt.addEventListener("keyup", (event) => {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    updateCommandMenu();
  }
});
el.prompt.addEventListener("blur", hideCommandMenu);

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------
//
// Pictures and documents go with the prompt that starts a turn. The script
// uploads each to the person's Anthropic Files API and the conversation refers
// to it, so a picture is sent once rather than with every turn.

const ATTACHABLE = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
];
const MAX_ATTACHMENTS = 5;
// The engine refuses a request past 10 MB; this leaves room for the form.
const MAX_ATTACHMENT_BYTES = 9.5 * 1024 * 1024;
// The model refuses a single picture past about 7.5 MB. Only a GIF, which is
// never redrawn, comes near it.
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
// The model works on pictures of at most about this many pixels on the long
// edge and scales anything larger down itself, so a larger one is only bytes
// to upload.
const IMAGE_EDGE = 1568;

let attachments = [];

el.attach.addEventListener("click", () => el.fileInput.click());
el.fileInput.addEventListener("change", () => {
  addFiles(el.fileInput.files);
  el.fileInput.value = "";
});

el.prompt.addEventListener("paste", (event) => {
  const files = event.clipboardData?.files;
  if (files && files.length > 0) {
    event.preventDefault();
    addFiles(files);
  }
});

el.promptSection.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  el.promptSection.classList.add("dropping");
});
el.promptSection.addEventListener("dragleave", () => {
  el.promptSection.classList.remove("dropping");
});
el.promptSection.addEventListener("drop", (event) => {
  el.promptSection.classList.remove("dropping");
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault();
  addFiles(event.dataTransfer.files);
});

async function addFiles(fileList) {
  if (runWorking) {
    setStatus(
      el.runStatus,
      "Files go with a new prompt. Wait for this run to finish, or stop it.",
      true,
    );
    return;
  }
  for (const file of Array.from(fileList)) {
    if (attachments.length >= MAX_ATTACHMENTS) {
      setStatus(el.runStatus, `At most ${MAX_ATTACHMENTS} files.`, true);
      break;
    }
    if (!ATTACHABLE.includes(file.type)) {
      setStatus(
        el.runStatus,
        `${file.name} is not a picture or a PDF or text document.`,
        true,
      );
      continue;
    }
    let blob = file;
    let name = file.name || "pasted";
    if (file.type.startsWith("image/")) {
      try {
        ({ blob, name } = await shrinkImage(file, name));
      } catch {
        // Sent as it is; the size check below still applies.
      }
    }
    if (blob.type.startsWith("image/") && blob.size > MAX_IMAGE_BYTES) {
      setStatus(
        el.runStatus,
        `${name} is a picture larger than the 7 MB the model reads.`,
        true,
      );
      continue;
    }
    if (attachedBytes() + blob.size > MAX_ATTACHMENT_BYTES) {
      setStatus(
        el.runStatus,
        `${name} would take this prompt past 9.5 MB.`,
        true,
      );
      continue;
    }
    attachments.push({
      blob,
      name,
      preview: blob.type.startsWith("image/") ? URL.createObjectURL(blob) : "",
    });
  }
  renderAttachments();
}

function attachedBytes() {
  return attachments.reduce((sum, a) => sum + a.blob.size, 0);
}

/**
 * A picture no larger than the model will look at. Left alone when it already
 * is; otherwise redrawn as a JPEG, on white, since JPEG has no transparency.
 * A GIF is left alone too, since redrawing it keeps only its first frame.
 */
async function shrinkImage(file, name) {
  if (file.type === "image/gif") return { blob: file, name };
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= 3.5 * 1024 * 1024) {
    bitmap.close();
    return { blob: file, name };
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("could not encode"))),
      "image/jpeg",
      0.85,
    ),
  );
  return { blob, name: name.replace(/\.[^.]*$/, "") + ".jpg" };
}

function renderAttachments() {
  el.attachments.hidden = attachments.length === 0;
  el.attachments.replaceChildren(
    ...attachments.map((attachment, index) => {
      const li = document.createElement("li");
      if (attachment.preview) {
        const img = document.createElement("img");
        img.src = attachment.preview;
        img.alt = "";
        li.append(img);
      }
      const name = document.createElement("span");
      name.className = "attachment-name";
      name.textContent = attachment.name;
      const size = document.createElement("span");
      size.className = "attachment-size";
      size.textContent = sizeLabel(attachment.blob.size);
      const remove = document.createElement("button");
      remove.className = "aw-button--secondary";
      remove.textContent = "×";
      remove.setAttribute("aria-label", "Remove " + attachment.name);
      remove.addEventListener("click", () => {
        if (attachment.preview) URL.revokeObjectURL(attachment.preview);
        attachments.splice(index, 1);
        renderAttachments();
      });
      li.append(name, size, remove);
      return li;
    }),
  );
}

function clearAttachments() {
  for (const attachment of attachments) {
    if (attachment.preview) URL.revokeObjectURL(attachment.preview);
  }
  attachments = [];
  renderAttachments();
}

function sizeLabel(bytes) {
  return bytes < 1024 * 1024
    ? Math.max(1, Math.round(bytes / 1024)) + " KB"
    : (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * The prompt and its files as a form. The engine accepts only plain file
 * names on an upload, so each goes up under a cleaned name and the names the
 * person sees travel beside them.
 */
function attachmentForm(fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.append(key, value);
  }
  form.append("names", JSON.stringify(attachments.map((a) => a.name)));
  attachments.forEach((attachment, index) => {
    const extension = (attachment.name.match(/\.[A-Za-z0-9]{1,8}$/) ?? [""])[0];
    form.append("file", attachment.blob, "file-" + (index + 1) + extension);
  });
  return form;
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------
//
// Both halves are the browser's own Web Speech API, so neither the script nor
// the model ever handles audio. Dictation fills the prompt box and the person
// still presses Run, so a misheard word is caught before it costs a turn. An
// answer is read from the same text the log shows. Chrome sends dictated audio
// to Google to recognise; Safari can recognise on the device.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const synth = window.speechSynthesis;
const SPEAK_KEY = "agent.speak";

// Chrome stops an utterance that runs much past fifteen seconds, so an answer
// is read as a queue of short ones.
const UTTERANCE_CHARS = 200;

let recognition = null;
// What was in the box when dictation started. Recognised text goes after it
// rather than over it.
let dictationBase = "";
let speakAnswers = false;

function setListening(on) {
  el.talk.setAttribute("aria-pressed", on ? "true" : "false");
  el.talk.textContent = on ? "Stop talking" : "Talk";
}

function startDictation() {
  stopSpeaking();
  const r = new Recognition();
  r.lang = navigator.language || "en-US";
  r.continuous = true;
  r.interimResults = true;
  dictationBase = el.prompt.value.trim();

  // Every result of the session, final and interim, so the box always shows
  // the whole of what has been heard so far.
  r.addEventListener("result", (event) => {
    if (r !== recognition) return;
    let heard = "";
    for (const result of event.results) heard += result[0].transcript;
    heard = heard.replace(/\s+/g, " ").trim();
    el.prompt.value = [dictationBase, heard].filter(Boolean).join(" ");
  });
  r.addEventListener("error", (event) => {
    if (
      event.error === "not-allowed" ||
      event.error === "service-not-allowed"
    ) {
      setStatus(
        el.runStatus,
        "The browser was not allowed to use the microphone.",
        true,
      );
    } else if (event.error !== "no-speech" && event.error !== "aborted") {
      setStatus(el.runStatus, "Dictation stopped: " + event.error + ".", true);
    }
  });
  r.addEventListener("end", () => {
    if (r !== recognition) return;
    recognition = null;
    setListening(false);
    el.prompt.focus();
  });

  recognition = r;
  setListening(true);
  setStatus(el.runStatus, "");
  r.start();
}

/** Stop listening and keep nothing that has not reached the box yet. */
function abortDictation() {
  if (!recognition) return;
  const r = recognition;
  recognition = null;
  setListening(false);
  r.abort();
}

if (Recognition) {
  el.talk.hidden = false;
  el.talk.addEventListener("click", () => {
    // Stopping rather than aborting: the last words are still being
    // recognised, and they are wanted.
    if (recognition) recognition.stop();
    else startDictation();
  });
}

if (synth) {
  el.speakChoice.hidden = false;
  try {
    speakAnswers = localStorage.getItem(SPEAK_KEY) === "1";
  } catch {
    // Storage can be unavailable; the switch then starts off.
  }
  el.speak.checked = speakAnswers;
  el.speak.addEventListener("change", () => {
    speakAnswers = el.speak.checked;
    try {
      localStorage.setItem(SPEAK_KEY, speakAnswers ? "1" : "0");
    } catch {
      // Remembered for this page only.
    }
    if (!speakAnswers) stopSpeaking();
  });
}

function stopSpeaking() {
  if (synth) synth.cancel();
}

/**
 * Read an answer aloud, if the person asked for that. Every open tab with the
 * switch on reads it: the switch is remembered per browser, not per tab.
 */
function speak(text) {
  if (!synth || !speakAnswers) return;
  const lang = navigator.language || "en-US";
  for (const part of speakableParts(text)) {
    const utterance = new SpeechSynthesisUtterance(part);
    utterance.lang = lang;
    synth.speak(utterance);
  }
}

/**
 * The answer as something to listen to: markdown marks dropped, code and
 * addresses named rather than spelled out, line ends read as pauses, then cut
 * at sentence ends into pieces short enough to be read whole.
 */
function speakableParts(text) {
  const plain = text
    .replace(/```[\s\S]*?```/g, " Code omitted. ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+?(?=[.,!?]?(\s|$))/g, "a link")
    .replace(/^\s*(#+|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*~>|]|_{2,}/g, "")
    // A heading or a list item ends without a full stop; the line break is
    // its pause.
    .replace(/([^.!?:;,\s])[ \t]*\n+/g, "$1. ")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = plain.match(/[^.!?]+[.!?]*\s*/g) ?? [];
  const parts = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > UTTERANCE_CHARS) {
      parts.push(current.trim());
      current = "";
    }
    current += sentence;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/** Put one conversation on screen from what `/agent/history` answered. */
function showHistory(history) {
  entries = history.activities ?? [];
  pending = "";
  shownRun = history.runId ?? "";
  showConversation(history.hasConversation, history.runKind);
  spend = history.spend ?? EMPTY_SPEND;
  renderSpend();
  render();

  // A run started before this page was opened is still a run: it can be
  // stopped and spoken to from here, which is the point of it not belonging
  // to the tab.
  const state = history.runState ?? "done";
  setWorking(state === "running" || state === "waiting");
  hidePlan();
  // A run suspended before this page was opened is still asking. Without
  // this the panel only ever appeared for whoever happened to be watching
  // when the plan landed.
  if (state === "waiting" && history.pendingPlan) {
    showPlan(history.pendingPlan.body);
  }
  setStatus(
    el.runStatus,
    runWorking ? "Working. You can close this page." : "",
  );
  renderConversationMarks();
}

async function start() {
  try {
    const history = await api("/agent/history");
    showKeyState(history.hasKey);
    pricing = history.pricing ?? null;
    contextWindow = history.contextWindow ?? 0;
    showHistory(history);

    loadMemories();
    loadConversations();
    loadCommands();

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

      // Another conversation's activity is not this one's log. A prompt is the
      // exception: it makes its conversation the one on screen.
      if (
        payload.runId &&
        shownRun &&
        payload.runId !== shownRun &&
        payload.kind !== "prompt"
      ) {
        return;
      }

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
        // A continued conversation keeps adding to its tally.
        if (payload.runId !== shownRun) {
          shownRun = payload.runId;
          entries = [];
          spend = EMPTY_SPEND;
          renderSpend();
        }
        loadConversations();
        showConversation(
          true,
          el.author && el.author.checked ? "author" : "chat",
        );
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

      // The end of a run is an activity like any other.
      if (payload.kind === "done") {
        hidePlan();
        // A run that just finished may have written, corrected or removed a
        // note, or a skill. Re-read rather than guess from the activity that
        // went past.
        loadMemories();
        loadCommands();
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

      if (payload.kind === "response") speak(payload.message);
      addEntry(payload);
    } catch {
      // Keep-alives and anything else the engine sends are not activity.
    }
  });
}

start();
