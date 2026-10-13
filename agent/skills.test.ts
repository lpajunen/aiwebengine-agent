/**
 * The format the agent writes and then has to read back.
 *
 * `write_skill` renders a SKILL.md and a later run parses it — two halves of
 * a format that nothing else validates, written a hundred lines apart. The
 * round-trip cases below are the point of this file: whatever
 * `renderSkillFile` writes, `frontMatterValue` and `skillBody` must read.
 */

import {
  LEARNED_PREFIX,
  SKILL_FILE,
  SKILL_NAME_PATTERN,
  frontMatterValue,
  learnedSkillPath,
  renderSkillFile,
  shortHash,
  skillBody,
  skillFolderOf,
  skillNameOf,
} from "./skills.ts";

describe("what a skill may be called", () => {
  test("accepts the shape a folder name has to have", () => {
    expect(SKILL_NAME_PATTERN.test("email")).toBe(true);
    expect(SKILL_NAME_PATTERN.test("weekly-report")).toBe(true);
    expect(SKILL_NAME_PATTERN.test("k8s")).toBe(true);
    expect(SKILL_NAME_PATTERN.test("a")).toBe(true);
  });

  test("refuses anything that could climb out of skills/", () => {
    // The name becomes a path segment, so this pattern is the whole of the
    // defence. A dot, a slash or a leading hyphen is a traversal waiting for
    // somewhere to be joined.
    expect(SKILL_NAME_PATTERN.test("..")).toBe(false);
    expect(SKILL_NAME_PATTERN.test("../secrets")).toBe(false);
    expect(SKILL_NAME_PATTERN.test("a/b")).toBe(false);
    expect(SKILL_NAME_PATTERN.test("a.b")).toBe(false);
    expect(SKILL_NAME_PATTERN.test("-lead")).toBe(false);
    expect(SKILL_NAME_PATTERN.test("")).toBe(false);
  });

  test("refuses upper case, so a library cannot hold Email and email", () => {
    expect(SKILL_NAME_PATTERN.test("Email")).toBe(false);
  });

  test("is bounded", () => {
    expect(SKILL_NAME_PATTERN.test("a".repeat(40))).toBe(true);
    expect(SKILL_NAME_PATTERN.test("a".repeat(41))).toBe(false);
  });
});

describe("skillNameOf", () => {
  test("names the skill a SKILL.md belongs to, shipped or learned", () => {
    expect(skillNameOf("skills/email/SKILL.md")).toBe("email");
    expect(skillNameOf("learned/email/SKILL.md")).toBe("email");
  });

  test("knows which folder each lives in", () => {
    expect(skillFolderOf("skills/email/SKILL.md")).toBe("skills/email/");
    expect(skillFolderOf("learned/email/SKILL.md")).toBe("learned/email/");
    expect(skillFolderOf("learned/email/notes.md")).toBe(null);
  });

  test("is null for anything that is not one", () => {
    expect(skillNameOf("skills/email/notes.md")).toBe(null);
    expect(skillNameOf("skills/SKILL.md")).toBe(null);
    expect(skillNameOf("other/email/SKILL.md")).toBe(null);
    expect(skillNameOf("skills//SKILL.md")).toBe(null);
    expect(skillNameOf("skills/a/b/SKILL.md")).toBe(null);
    expect(skillNameOf("learned/SKILL.md")).toBe(null);
  });

  test("round-trips with the path the writer uses", () => {
    // The one pairing that has to hold: what write_skill stores is what the
    // index later recognises as a skill.
    expect(learnedSkillPath("weekly-report")).toBe(
      LEARNED_PREFIX + "weekly-report/" + SKILL_FILE,
    );
    expect(skillNameOf(learnedSkillPath("weekly-report"))).toBe(
      "weekly-report",
    );
  });
});

describe("a rendered skill reads back as what was written", () => {
  test("name, description and body all survive the round trip", () => {
    const file = renderSkillFile(
      "weekly-report",
      "How to put together the Monday summary.",
      "1. Read the log.\n2. Write it up.",
    );
    expect(frontMatterValue(file, "name")).toBe("weekly-report");
    expect(frontMatterValue(file, "description")).toBe(
      "How to put together the Monday summary.",
    );
    expect(skillBody(file)).toBe("1. Read the log.\n2. Write it up.\n");
  });

  test("a body that itself contains --- is not mistaken for front matter", () => {
    // Markdown uses --- as a rule, and a skill body is markdown.
    const file = renderSkillFile("x", "d", "one\n\n---\n\ntwo");
    expect(frontMatterValue(file, "name")).toBe("x");
    expect(skillBody(file)).toBe("one\n\n---\n\ntwo\n");
  });

  test("an empty body leaves the front matter readable", () => {
    const file = renderSkillFile("x", "d", "");
    expect(frontMatterValue(file, "name")).toBe("x");
    expect(frontMatterValue(file, "description")).toBe("d");
    expect(skillBody(file)).toBe("");
  });
});

describe("frontMatterValue", () => {
  test("is empty when there is no front matter to read", () => {
    expect(frontMatterValue("just a body", "name")).toBe("");
    expect(frontMatterValue("---\nname: x", "name")).toBe("");
    expect(frontMatterValue("", "name")).toBe("");
  });

  test("is empty for a key that is not there", () => {
    expect(frontMatterValue("---\nname: x\n---\n", "description")).toBe("");
  });

  test("matches the key without regard to case or spacing", () => {
    expect(frontMatterValue("---\n  Name  :   x  \n---\n", "name")).toBe("x");
  });

  test("takes quotes off a quoted value and leaves inner ones alone", () => {
    expect(frontMatterValue('---\nname: "x"\n---\n', "name")).toBe("x");
    expect(frontMatterValue("---\nname: 'x'\n---\n", "name")).toBe("x");
    expect(frontMatterValue('---\nname: say "hi"\n---\n', "name")).toBe(
      'say "hi"',
    );
  });

  test("keeps a colon in the value", () => {
    expect(frontMatterValue("---\nname: a: b\n---\n", "name")).toBe("a: b");
  });
});

describe("skillBody", () => {
  test("hands back a file with no front matter unchanged", () => {
    expect(skillBody("just a body")).toBe("just a body");
    expect(skillBody("---\nunclosed")).toBe("---\nunclosed");
  });
});

describe("shortHash", () => {
  test("is stable, and different for different text", () => {
    // The skill index is cached under this. A hash that moved between turns
    // would rewrite the cached prompt prefix every time, silently.
    expect(shortHash("abc")).toBe(shortHash("abc"));
    expect(shortHash("abc")).not.toBe(shortHash("abd"));
    expect(shortHash("")).toBe(shortHash(""));
  });

  test("is short and has no characters a key cannot hold", () => {
    expect(shortHash("x".repeat(5000)).length < 8).toBe(true);
    expect(/^[a-z0-9]+$/.test(shortHash("anything at all"))).toBe(true);
  });
});
