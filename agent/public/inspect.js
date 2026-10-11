// What the model sees.
//
// Reads one conversation's record from /agent/context and lays it out in the
// order the model reads it: settings, the system prompt in its parts, the
// tools, the messages. What it shows before the conversation is what a turn
// actually sent, kept when the turn ran, not rebuilt now: a run's tools and
// instructions follow what its grant held, which this page cannot see.

const $ = (id) => document.getElementById(id);

const ROLE = { user: "You", assistant: "Model" };

let data = null;
let skills = [];
let shown = null;

// About four characters a token: close enough to show proportions, and
// labelled ≈ wherever it is used.
function estimate(text) {
  return Math.ceil(String(text).length / 4);
}

function tokens(n) {
  return "≈ " + n.toLocaleString("en-US") + " tokens";
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function pre(text) {
  return make("pre", "", text);
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

function firstLine(text, max) {
  const line = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

// One collapsible entry. `fill` builds the body the first time it opens, so a
// long conversation does not lay out a thousand <pre>s nobody reads.
function item(parts, fill) {
  const details = make("details", "item");
  const summary = document.createElement("summary");
  for (const part of parts) summary.appendChild(part);
  details.appendChild(summary);
  const body = make("div", "item-body");
  details.appendChild(body);
  let filled = false;
  details.addEventListener("toggle", () => {
    if (details.open && !filled) {
      filled = true;
      fill(body);
    }
  });
  return details;
}

function systemText(prompt) {
  return prompt.parts.map((p) => p.sep + p.text).join("");
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Instructions: the person's, editable, and the deployment's, read-only
// ---------------------------------------------------------------------------

let ownMax = 4000;
let savedOwn = "";

function showOwnSize() {
  const text = $("own-instructions").value.trim();
  $("own-size").textContent =
    text.length.toLocaleString("en-US") +
    " / " +
    ownMax.toLocaleString("en-US") +
    " characters · " +
    tokens(estimate(text));
  $("own-size").classList.toggle("error", text.length > ownMax);
  $("save-instructions").disabled = text === savedOwn || text.length > ownMax;
}

async function loadInstructions() {
  const response = await fetch("/agent/instructions");
  if (!response.ok) return;
  const body = await response.json();
  ownMax = body.max || ownMax;
  savedOwn = body.own || "";
  $("own-instructions").value = savedOwn;
  $("own-instructions").maxLength = ownMax;
  if (body.shared) {
    $("shared-label").textContent =
      "This deployment's instructions, from " +
      body.sharedFile +
      ". Where yours disagree, these win.";
    $("shared-instructions").textContent = body.shared;
    $("shared-instructions").hidden = false;
  } else {
    $("shared-label").textContent =
      "This deployment has no instructions of its own.";
  }
  $("instructions").hidden = false;
  showOwnSize();
  if (location.hash === "#instructions") $("instructions").scrollIntoView();
}

$("own-instructions").addEventListener("input", () => {
  $("instructions-status").textContent = "";
  showOwnSize();
});

$("save-instructions").addEventListener("click", async () => {
  const text = $("own-instructions").value.trim();
  $("save-instructions").disabled = true;
  $("instructions-status").classList.remove("error");
  $("instructions-status").textContent = "Saving…";
  try {
    const response = await fetch("/agent/instructions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: text }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(body.error || "status " + response.status);
    savedOwn = body.own;
    $("own-instructions").value = savedOwn;
    $("instructions-status").textContent = savedOwn
      ? "Saved. Your next prompt uses them."
      : "Cleared. Your next prompt goes without.";
  } catch (e) {
    $("instructions-status").classList.add("error");
    $("instructions-status").textContent = "Could not save: " + e.message;
  }
  showOwnSize();
});

async function load() {
  const runId = new URLSearchParams(location.search).get("runId") || "";
  const [context, library] = await Promise.all([
    fetch(
      "/agent/context" + (runId ? "?runId=" + encodeURIComponent(runId) : ""),
    ),
    fetch("/agent/skills"),
  ]);

  if (library.ok) {
    skills = (await library.json()).skills || [];
    renderSkills();
  } else {
    $("skills").replaceChildren(
      make("p", "status error", "Could not load the skills."),
    );
  }

  if (context.status === 401) {
    $("status").textContent = "Sign in to see your conversations.";
    $("skills").replaceChildren(
      make("p", "status", "Sign in to see the skills."),
    );
    return;
  }
  if (!context.ok) {
    const body = await context.json().catch(() => ({}));
    $("status").textContent = body.error || "Could not load the conversation.";
    $("status").classList.add("error");
    return;
  }
  data = await context.json();
  if (!data.runId) {
    $("status").textContent =
      "No conversation yet. Send a prompt, then come back to see what it sent.";
    return;
  }
  if (data.title) $("conversation").textContent = "“" + data.title + "”";
  if (data.prompts.length === 0) {
    $("status").textContent =
      "This conversation has no record of what its turns sent: it ran before " +
      "this page kept one. Its messages are below; send a prompt in it to " +
      "record the rest.";
  } else {
    $("status").hidden = true;
  }
  $("content").hidden = false;
  shown = data.prompts.length ? data.prompts[data.prompts.length - 1] : null;
  renderVersions();
  renderMessages();
  renderTurns();
  renderShown();
}

// ---------------------------------------------------------------------------
// Versions: one per distinct thing a turn sent before the conversation
// ---------------------------------------------------------------------------

function turnsOf(mark) {
  const numbers = [];
  data.turns.forEach((turn, i) => {
    if (turn.mark === mark) numbers.push(i + 1);
  });
  return numbers;
}

function versionName(mark) {
  const index = data.prompts.findIndex((p) => p.mark === mark);
  return index === -1 ? "" : "v" + (index + 1);
}

function range(numbers) {
  if (numbers.length === 0) return "no turns";
  const first = numbers[0];
  const last = numbers[numbers.length - 1];
  return first === last ? "turn " + first : "turns " + first + "–" + last;
}

function renderVersions() {
  if (data.prompts.length < 2) return;
  $("versions-section").hidden = false;
  const holder = $("versions");
  holder.replaceChildren();
  for (const prompt of data.prompts) {
    const button = make(
      "button",
      "aw-button--secondary",
      versionName(prompt.mark) + " · " + range(turnsOf(prompt.mark)),
    );
    button.type = "button";
    button.setAttribute("aria-pressed", String(prompt === shown));
    button.addEventListener("click", () => {
      shown = prompt;
      for (const other of holder.children) {
        other.setAttribute("aria-pressed", String(other === button));
      }
      renderShown();
    });
    holder.appendChild(button);
  }
}

function renderShown() {
  renderSettings();
  renderSystem();
  renderTools();
  renderBar();
  renderRaw();
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const SETTING_HELP = {
  model: "Which model answers.",
  max_tokens: "The most one turn may write, its thinking included.",
  thinking:
    "The model thinks before it answers, as much as the question needs.",
  output_config: "How hard it tries: more effort, more thinking, more cost.",
  cache_control:
    "Caches everything sent so far, so the next turn pays a tenth for it.",
  anthropic_beta: "Features turned on that are not on by default yet.",
};

function renderSettings() {
  const list = $("settings");
  list.replaceChildren();
  if (!shown) {
    list.appendChild(make("dd", "", "Not recorded for this conversation."));
    return;
  }
  for (const key of Object.keys(shown.settings)) {
    const value = shown.settings[key];
    if (value === undefined || value === null) continue;
    list.appendChild(make("dt", "", key));
    const dd = make(
      "dd",
      "",
      typeof value === "object" ? JSON.stringify(value) : String(value),
    );
    if (SETTING_HELP[key]) dd.appendChild(make("small", "", SETTING_HELP[key]));
    list.appendChild(dd);
  }
}

function renderSystem() {
  const holder = $("system");
  holder.replaceChildren();
  if (!shown) {
    $("system-size").textContent = "";
    holder.appendChild(
      make("p", "status", "Not recorded for this conversation."),
    );
    return;
  }
  $("system-size").textContent = tokens(estimate(systemText(shown)));
  for (const part of shown.parts) {
    holder.appendChild(
      item(
        [
          make("span", "item-title", part.label),
          make("span", "size", tokens(estimate(part.text))),
        ],
        (body) => {
          body.appendChild(make("p", "why", part.why));
          body.appendChild(pre(part.text));
        },
      ),
    );
  }
}

function renderTools() {
  const holder = $("tools");
  holder.replaceChildren();
  if (!shown) {
    $("tools-size").textContent = "";
    holder.appendChild(
      make("p", "status", "Not recorded for this conversation."),
    );
    return;
  }
  $("tools-size").textContent =
    shown.tools.length + " · " + tokens(estimate(JSON.stringify(shown.tools)));
  for (const tool of shown.tools) {
    const title = make("span", "item-title");
    title.appendChild(make("span", "item-name", tool.name));
    title.appendChild(
      make("span", "item-note", " — " + firstLine(tool.description, 90)),
    );
    holder.appendChild(
      item(
        [title, make("span", "size", tokens(estimate(JSON.stringify(tool))))],
        (body) => {
          body.appendChild(pre(tool.description));
          body.appendChild(make("p", "block-label", "Input schema"));
          body.appendChild(pre(json(tool.input_schema)));
        },
      ),
    );
  }
}

// The name of each tool call, so a result can say which call it answers.
function callNames() {
  const names = {};
  for (const message of data.messages) {
    for (const block of message.content || []) {
      if (block.type === "tool_use") names[block.id] = block.name;
    }
  }
  return names;
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return json(content);
  return content
    .map((block) => (block.type === "text" ? block.text : json(block)))
    .join("\n");
}

// What a block is, in a few words, for the message's one-line summary.
function blockSummary(block, names) {
  switch (block.type) {
    case "text":
      return firstLine(block.text, 80);
    case "tool_use":
      return "calls " + block.name;
    case "tool_result":
      return (
        (block.is_error ? "error from " : "result of ") +
        (names[block.tool_use_id] || "a tool")
      );
    case "thinking":
    case "redacted_thinking":
      return "thinks";
    case "image":
      return "a picture";
    case "document":
      return "a document";
    default:
      return block.type;
  }
}

function renderBlock(body, block, names) {
  switch (block.type) {
    case "text":
      body.appendChild(pre(block.text));
      return;
    case "tool_use":
      body.appendChild(make("p", "block-label", "Calls " + block.name));
      body.appendChild(pre(json(block.input)));
      return;
    case "tool_result":
      body.appendChild(
        make(
          "p",
          "block-label",
          (block.is_error ? "Error from " : "Result of ") +
            (names[block.tool_use_id] || "a tool"),
        ),
      );
      body.appendChild(pre(resultText(block.content)));
      return;
    case "thinking":
      body.appendChild(
        make(
          "p",
          "block-label",
          "Thinking, sent back so the model keeps its reasoning",
        ),
      );
      body.appendChild(pre(block.thinking || "(empty)"));
      return;
    case "redacted_thinking":
      body.appendChild(
        make("p", "block-label", "Thinking the model keeps hidden"),
      );
      return;
    case "image":
    case "document": {
      const source = block.source || {};
      body.appendChild(
        make(
          "p",
          "block-label",
          (block.type === "image" ? "A picture" : "A document") +
            (source.file_id ? ", sent by file id " + source.file_id : ""),
        ),
      );
      return;
    }
    default:
      body.appendChild(make("p", "block-label", block.type));
      body.appendChild(pre(json(block)));
  }
}

function messageSize(message) {
  // Signatures are opaque and are not what the model reads as text, so they
  // are left out of the estimate.
  return estimate(
    JSON.stringify(message.content, (key, value) =>
      key === "signature" ? undefined : value,
    ),
  );
}

function renderMessages() {
  const holder = $("messages");
  holder.replaceChildren();
  const names = callNames();
  let total = 0;
  data.messages.forEach((message, i) => {
    const size = messageSize(message);
    total += size;
    const blocks = message.content || [];
    const said = blocks
      .filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking")
      .map((b) => blockSummary(b, names));
    holder.appendChild(
      item(
        [
          make(
            "span",
            "role",
            i + 1 + " · " + (ROLE[message.role] || message.role),
          ),
          make("span", "item-title", said.join(" · ") || "thinks"),
          make("span", "size", tokens(size)),
        ],
        (body) => {
          for (const block of blocks) renderBlock(body, block, names);
        },
      ),
    );
  });
  if (data.messages.length === 0) {
    holder.appendChild(make("p", "status", "Nothing yet."));
  }
  $("messages-size").textContent = data.messages.length + " · " + tokens(total);
}

function dollars(turn) {
  const p = data.pricing;
  const cost =
    (turn.fresh * p.freshPerM +
      turn.wrote * p.cacheWritePerM +
      turn.cached * p.cacheReadPerM +
      turn.output * p.outputPerM) /
    1000000;
  return cost < 0.01 ? "<$0.01" : "$" + cost.toFixed(2);
}

function renderTurns() {
  const body = $("turns");
  body.replaceChildren();
  let total = 0;
  data.turns.forEach((turn, i) => {
    const row = document.createElement("tr");
    const version = turn.mark ? versionName(turn.mark) || "—" : "summary";
    const cells = [
      String(i + 1),
      version,
      turn.cached.toLocaleString("en-US"),
      turn.wrote.toLocaleString("en-US"),
      turn.fresh.toLocaleString("en-US"),
      turn.output.toLocaleString("en-US"),
      dollars(turn),
    ];
    for (const text of cells) row.appendChild(make("td", "", text));
    body.appendChild(row);
    total += turn.cached + turn.wrote + turn.fresh + turn.output;
  });
  if (data.turns.length === 0) {
    const row = document.createElement("tr");
    const cell = make("td", "status", "No turns yet.");
    cell.colSpan = 7;
    row.appendChild(cell);
    body.appendChild(row);
  }
  $("turns-size").textContent =
    data.turns.length + " · " + total.toLocaleString("en-US") + " tokens";
}

function renderBar() {
  const sizes = [
    ["system", "Instructions", shown ? estimate(systemText(shown)) : 0],
    ["tools", "Tools", shown ? estimate(JSON.stringify(shown.tools)) : 0],
    [
      "messages",
      "Conversation",
      data.messages.reduce((n, m) => n + messageSize(m), 0),
    ],
  ];
  const total = sizes.reduce((n, s) => n + s[2], 0);
  $("total-size").textContent = tokens(total);
  const bar = $("bar");
  const legend = $("legend");
  bar.replaceChildren();
  legend.replaceChildren();
  for (const [key, label, size] of sizes) {
    const share = total ? (size / total) * 100 : 0;
    const segment = make("span", "c-" + key);
    segment.style.width = share + "%";
    bar.appendChild(segment);
    const entry = make("li");
    entry.appendChild(make("span", "swatch c-" + key));
    entry.appendChild(
      document.createTextNode(
        label + " " + tokens(size) + " (" + Math.round(share) + "%)",
      ),
    );
    legend.appendChild(entry);
  }
}

// The request body as callModel builds it, from the same recorded values.
function rawRequest() {
  const settings = shown ? shown.settings : {};
  return {
    model: settings.model,
    max_tokens: settings.max_tokens,
    system: shown ? systemText(shown) : undefined,
    messages: data.messages,
    tools: shown ? shown.tools : undefined,
    stream: true,
    cache_control: settings.cache_control,
    thinking: settings.thinking,
    output_config: settings.output_config,
  };
}

function renderRaw() {
  const raw = $("raw");
  const out = $("raw-json");
  out.textContent = "";
  // Built when opened: the conversation can be large.
  if (raw.open) out.textContent = json(rawRequest());
}

$("raw").addEventListener("toggle", () => {
  if ($("raw").open && data) $("raw-json").textContent = json(rawRequest());
});

$("copy-raw").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(json(rawRequest()));
    $("copy-status").textContent = "Copied.";
  } catch (e) {
    $("copy-status").textContent = "Could not copy; select the text instead.";
  }
});

function renderSkills() {
  const holder = $("skills");
  holder.replaceChildren();
  $("skills-size").textContent = String(skills.length);
  if (skills.length === 0) {
    holder.appendChild(
      make(
        "p",
        "status",
        "No skills yet. The agent can write one when it works out something worth repeating, and asks before it does.",
      ),
    );
    return;
  }
  for (const skill of skills) {
    const title = make("span", "item-title");
    title.appendChild(make("span", "item-name", "/" + skill.name));
    title.appendChild(
      make("span", "item-note", " — " + firstLine(skill.description, 90)),
    );
    holder.appendChild(
      item(
        [title, make("span", "size", tokens(estimate(skill.body)))],
        (body) => {
          body.appendChild(make("p", "why", skill.description));
          body.appendChild(
            pre(
              skill.body +
                (skill.cut
                  ? "\n\n[cut here: the model sees no more either]"
                  : ""),
            ),
          );
          if (skill.files.length) {
            body.appendChild(
              make(
                "p",
                "block-label",
                "Other files the model can read with read_skill",
              ),
            );
            body.appendChild(pre(skill.files.join("\n")));
          }
        },
      ),
    );
  }
}

loadInstructions().catch(() => {});
load().catch((e) => {
  $("status").textContent = "Could not load: " + e;
  $("status").classList.add("error");
});
