/**
 * The SKILL.md format, written and read.
 *
 * Both halves live here on purpose. The agent writes a skill with
 * `write_skill` and reads it back on a later run through the index and
 * `read_skill`, so the writer and the parser have to agree about a format
 * that nothing else validates. They were written a hundred lines apart in one
 * file, which is exactly the distance at which two halves of a format drift.
 * `skills.test.ts` puts them back to back: what `renderSkillFile` writes,
 * `frontMatterValue` and `skillBody` must read.
 *
 * Apart from `main.ts` for the reason `protocol.ts` gives — a root script
 * cannot `export`.
 */

export const SKILLS_PREFIX = "skills/";
export const SKILL_FILE = "SKILL.md";

/**
 * What a skill may be called.
 *
 * The folder name *is* the skill's name, so this is a directory segment as
 * much as an identifier: no dots, no slashes, nothing that could climb out of
 * `skills/`. Lower case because the model copies the name out of prose and a
 * library that distinguishes `Email` from `email` is one that will eventually
 * hold both.
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Where a skill's own file lives. */
export function skillAssetPath(name: string): string {
  return SKILLS_PREFIX + name + "/" + SKILL_FILE;
}

/** The skill an asset belongs to, or null if it is not a skill's SKILL.md. */
export function skillNameOf(assetName: string): string | null {
  if (assetName.indexOf(SKILLS_PREFIX) !== 0) return null;
  const rest = assetName.slice(SKILLS_PREFIX.length);
  const cut = rest.indexOf("/");
  if (cut <= 0) return null;
  if (rest.slice(cut + 1) !== SKILL_FILE) return null;
  return rest.slice(0, cut);
}

/**
 * A skill's file, from the three things the model was asked for.
 *
 * The description goes on its line unquoted and unescaped, which bounds what
 * this format can carry: a newline in it would end the line early and a
 * following `---` would close the block. `skillWriteArgs` is where that is
 * refused, because refusing at the point of writing is a message the model
 * can act on, and refusing here would be a file that parses back wrong.
 */
export function renderSkillFile(
  name: string,
  description: string,
  body: string,
): string {
  return (
    "---\n" +
    "name: " +
    name +
    "\n" +
    "description: " +
    description +
    "\n" +
    "---\n\n" +
    body +
    "\n"
  );
}

/**
 * One `key: value` out of a leading `---` front-matter block.
 *
 * Deliberately not a YAML parser: the format's whole job here is to carry one
 * description line, and a parser that accepted more would be promising a
 * fidelity nothing downstream honours.
 */
export function frontMatterValue(text: string, key: string): string {
  if (text.indexOf("---") !== 0) return "";
  const close = text.indexOf("\n---", 3);
  if (close === -1) return "";

  for (const line of text.slice(3, close).split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== key) continue;

    let value = line.slice(colon + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value[0] === '"' && value[value.length - 1] === '"') ||
        (value[0] === "'" && value[value.length - 1] === "'"));
    if (quoted) value = value.slice(1, -1);
    return value;
  }
  return "";
}

/** What is left of a SKILL.md once the front matter is taken off. */
export function skillBody(text: string): string {
  if (text.indexOf("---") !== 0) return text;
  const close = text.indexOf("\n---", 3);
  if (close === -1) return text;
  const lineEnd = text.indexOf("\n", close + 1);
  if (lineEnd === -1) return "";
  return text.slice(lineEnd + 1).replace(/^\n+/, "");
}

/** A short, stable mark for a string. Used to notice a changed skill index. */
export function shortHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}
