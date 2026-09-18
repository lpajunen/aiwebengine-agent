// The browser half of the loop.
//
// The engine has nowhere to run an agent turn except inside a request from the
// person it belongs to, so this page is what keeps the run moving: it posts one
// step, reads whether the run is finished, and posts the next. The SSE stream
// is how activity arrives — including activity from another tab or device —
// while the POST responses only say whether to keep going.

const MAX_STEPS = 12;

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
    const error = new Error(
      body.error ?? `Request failed (${response.status})`,
    );
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
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
  setStatus(el.runStatus, "Thinking...");

  try {
    const { runId } = await api("/agent/prompt", {
      method: "POST",
      body: JSON.stringify({ prompt }),
    });
    el.prompt.value = "";

    // One request per turn. Each gets its own execution budget on the engine,
    // which is the whole reason the loop lives here rather than there.
    for (let step = 0; step < MAX_STEPS; step += 1) {
      setStatus(el.runStatus, `Working (turn ${step + 1})...`);
      const result = await api("/agent/step", {
        method: "POST",
        body: JSON.stringify({ runId }),
      });
      if (result.done) {
        setStatus(
          el.runStatus,
          result.reason === "error" ? "Stopped." : "Done.",
          result.reason === "error",
        );
        return;
      }
    }
    setStatus(el.runStatus, "Stopped: too many turns.", true);
  } catch (e) {
    if (e.status === 401) {
      setStatus(el.runStatus, "Sign in to run the agent.", true);
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
  } catch (e) {
    if (e.status === 401) {
      setStatus(el.runStatus, "Sign in at /auth/login to use the agent.", true);
      el.run.disabled = true;
      return;
    }
    setStatus(el.runStatus, e.message, true);
  }

  // Activity arrives here rather than from the step responses, so a second tab
  // — or the same page after a refresh — sees the same run unfold.
  const events = new EventSource("/agent/events");
  events.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload && typeof payload.message === "string") addEntry(payload);
    } catch {
      // Keep-alives and anything else the engine sends are not activity.
    }
  });
}

start();
