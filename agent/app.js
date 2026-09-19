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

const el = {
  keyPanel: document.getElementById("key-panel"),
  key: document.getElementById("key"),
  saveKey: document.getElementById("save-key"),
  forgetKey: document.getElementById("forget-key"),
  keyStatus: document.getElementById("key-status"),
  prompt: document.getElementById("prompt"),
  run: document.getElementById("run"),
  runStatus: document.getElementById("run-status"),
  activity: document.getElementById("activity"),
};

let entries = [];
let running = false;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  if (entries.length === 0) {
    el.activity.innerHTML = '<li class="empty">Nothing yet.</li>';
    return;
  }
  el.activity.replaceChildren(
    ...entries.map((entry) => {
      const li = document.createElement("li");
      const kind = document.createElement("span");
      kind.className = "kind";
      kind.dataset.kind = entry.kind;
      kind.textContent = entry.kind;
      const message = document.createElement("p");
      message.className = "message";
      message.textContent = entry.message;
      li.append(kind, message);
      return li;
    }),
  );
  el.activity.lastElementChild?.scrollIntoView({ block: "nearest" });
}

function addEntry(entry) {
  entries.push(entry);
  render();
}

function setStatus(node, text, isError) {
  node.textContent = text;
  node.classList.toggle("error", Boolean(isError));
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
      setStatus(el.runStatus, "Sign in to run the agent.", true);
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
  setStatus(el.runStatus, "", false);
  el.runStatus.textContent = body.error + " ";
  const link = document.createElement("a");
  link.href = body.consentUrl + "&redirect=" + encodeURIComponent("/agent");
  link.textContent = "Give permission";
  el.runStatus.appendChild(link);
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
      setStatus(el.runStatus, "Sign in at /auth/login to use the agent.", true);
      el.run.disabled = true;
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

      // The end of a run is an activity like any other now. It used to be the
      // reply to the step the page was waiting on, and there is nothing to
      // wait on any more.
      if (payload.kind === "done") {
        setStatus(
          el.runStatus,
          payload.message === "error" || payload.message === "step-limit"
            ? "Stopped."
            : "Done.",
          payload.message === "error" || payload.message === "step-limit",
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
