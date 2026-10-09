/**
 * What a prompt with pictures and documents becomes in the conversation.
 */

import {
  attachmentKind,
  blockFor,
  describeAttachments,
  originalNames,
  promptBlocks,
} from "./attachments.ts";

describe("which files the model reads", () => {
  test("pictures become images and PDFs and text become documents", () => {
    expect(attachmentKind("image/jpeg")).toBe("image");
    expect(attachmentKind("image/webp")).toBe("image");
    expect(attachmentKind("application/pdf")).toBe("document");
    expect(attachmentKind("text/plain; charset=utf-8")).toBe("document");
  });

  test("anything else is refused rather than sent", () => {
    expect(attachmentKind("application/zip")).toBe(null);
    expect(attachmentKind("")).toBe(null);
  });
});

describe("the blocks", () => {
  test("a picture refers to its file and carries no title", () => {
    expect(
      blockFor({
        name: "cat.jpg",
        contentType: "image/jpeg",
        fileId: "file_1",
      }),
    ).toEqual({ type: "image", source: { type: "file", file_id: "file_1" } });
  });

  test("a document is titled with the name the person gave it", () => {
    expect(
      blockFor({
        name: "Q3 report.pdf",
        contentType: "application/pdf",
        fileId: "file_2",
      }),
    ).toEqual({
      type: "document",
      source: { type: "file", file_id: "file_2" },
      title: "Q3 report.pdf",
    });
  });

  test("attachments come before the words, and words are optional", () => {
    const picture = {
      name: "a.png",
      contentType: "image/png",
      fileId: "file_3",
    };
    const withText = promptBlocks("What is this?", [picture]);
    expect(withText.map((b) => b.type)).toEqual(["image", "text"]);
    expect(promptBlocks("", [picture]).map((b) => b.type)).toEqual(["image"]);
  });
});

describe("names", () => {
  test("the names sent beside the files are used in order", () => {
    expect(originalNames('["My photo.jpg","notes.txt"]', 2)).toEqual([
      "My photo.jpg",
      "notes.txt",
    ]);
  });

  test("a missing or broken list still names every file", () => {
    expect(originalNames("not json", 2)).toEqual([
      "attachment-1",
      "attachment-2",
    ]);
    expect(originalNames('["only one"]', 2)).toEqual([
      "only one",
      "attachment-2",
    ]);
  });

  test("the log line says what each file was", () => {
    expect(
      describeAttachments([
        { name: "cat.jpg", contentType: "image/jpeg", fileId: "f" },
        { name: "spec.pdf", contentType: "application/pdf", fileId: "g" },
      ]),
    ).toBe("cat.jpg (picture), spec.pdf (document)");
  });
});
