/**
 * Reading what the model sent, before any of it is believed.
 *
 * Four string functions and one rule about content blocks. None of them touch
 * the engine, the database or a run — which is the point of their being here
 * rather than in `main.ts`: a root script cannot use `export`, so anything a
 * test is able to reach has to live in a module beside it. That constraint is
 * what shaped this file, and it turned out to be a good one. Everything below
 * is the part of a turn that is pure text handling, and it is also the part
 * where a mistake is silent — a half-decoded escape reaches somebody's screen
 * as the wrong character, and an answer filed as a note reaches them in the
 * voice the model uses talking to itself.
 *
 * Covered by `protocol.test.ts`.
 */

/** The `data:` lines of one frame, joined as the SSE format defines. */
export function frameData(frame: string): string {
  const parts: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.indexOf("data:") !== 0) continue;
    const value = line.slice(5);
    // One space after the colon is the field separator rather than content.
    parts.push(value.indexOf(" ") === 0 ? value.slice(1) : value);
  }
  return parts.join("\n");
}

/**
 * As much of a string field as a half-written JSON object will give up.
 *
 * `JSON.parse` is all-or-nothing and the object is by definition incomplete.
 * This reads the one field it is asked for and stops wherever the text runs
 * out — mid-escape included, since `\u00` is not yet a character and guessing
 * the rest would put the wrong one on somebody's screen.
 */
export function jsonStringPrefix(partial: string, key: string): string {
  const marker = '"' + key + '"';
  const at = partial.indexOf(marker);
  if (at === -1) return "";

  let i = at + marker.length;
  while (i < partial.length && (partial[i] === " " || partial[i] === ":")) i++;
  if (partial[i] !== '"') return "";
  i++;

  let out = "";
  while (i < partial.length) {
    const c = partial[i];
    if (c === '"') return out;
    if (c !== "\\") {
      out += c;
      i++;
      continue;
    }

    if (i + 1 >= partial.length) return out;
    const escape = partial[i + 1];
    if (escape === "u") {
      if (i + 6 > partial.length) return out;
      out += String.fromCharCode(parseInt(partial.slice(i + 2, i + 6), 16));
      i += 6;
      continue;
    }
    out += unescapeOne(escape);
    i += 2;
  }
  return out;
}

export function unescapeOne(escape: string): string {
  switch (escape) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "b":
      return "\b";
    case "f":
      return "\f";
    // `"`, `\` and `/` stand for themselves.
    default:
      return escape;
  }
}

/**
 * What an error body says, or the first of it if it says nothing.
 *
 * The shape is written out rather than imported, because the module loader has
 * no `import type` and a value import of a type would generate a `const` bound
 * to nothing. One field of one object is cheap to state twice; `ApiResponse` in
 * `main.ts` is the fuller version of the same thing.
 */
export function readErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message ?? body.slice(0, 200);
  } catch (e) {
    return body.slice(0, 200);
  }
}

/**
 * What this turn's prose is: the answer, or talk about what it is doing.
 *
 * A turn that calls no tool ends the run, so its text is the last thing the
 * person will hear and is therefore the answer — whether or not the model
 * bothered with `write_response`. Text beside a tool call is narration, and
 * stays a note.
 *
 * The rule lives apart from the loop because it is the whole of what decides
 * whether somebody's answer arrives looking like an aside. It reads three
 * fields of a block, so it is written against those three rather than against
 * `ContentBlock` — see `readErrorMessage` for why a type does not cross this
 * boundary.
 */
export function proseKindFor(
  blocks: { type: string; id?: string; name?: string }[],
): "note" | "response" {
  for (const block of blocks) {
    if (block.type === "tool_use" && block.id && block.name) return "note";
  }
  return "response";
}
