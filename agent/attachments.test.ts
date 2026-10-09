/**
 * What a prompt with pictures and documents becomes in the conversation.
 */

import {
  attachmentKind,
  blockFor,
  describeAttachments,
  originalNames,
  MAX_PREVIEW_CHARS,
  parseDetail,
  previewOf,
  promptBlocks,
  telegramFiles,
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

describe("files from Telegram", () => {
  test("the largest photo size the model reads whole is chosen", () => {
    const { files } = telegramFiles({
      photo: [
        { file_id: "s", width: 90, height: 67 },
        { file_id: "m", width: 800, height: 600 },
        { file_id: "l", width: 1280, height: 960 },
        { file_id: "xl", width: 2560, height: 1920 },
      ],
    });
    expect(files).toEqual([
      { telegramId: "l", name: "photo.jpg", contentType: "image/jpeg" },
    ]);
  });

  test("when every size is too large, the smallest is the least waste", () => {
    const { files } = telegramFiles({
      photo: [
        { file_id: "big", width: 4000, height: 3000 },
        { file_id: "bigger", width: 8000, height: 6000 },
      ],
    });
    expect(files[0].telegramId).toBe("big");
  });

  test("a PDF is passed on under its own name", () => {
    expect(
      telegramFiles({
        document: {
          file_id: "d",
          file_name: "spec.pdf",
          mime_type: "application/pdf",
          file_size: 1000,
        },
      }),
    ).toEqual({
      files: [
        { telegramId: "d", name: "spec.pdf", contentType: "application/pdf" },
      ],
    });
  });

  test("a document the model cannot read is refused by name", () => {
    const answer = telegramFiles({
      document: {
        file_id: "z",
        file_name: "archive.zip",
        mime_type: "application/zip",
      },
    });
    expect(answer.files).toEqual([]);
    expect(answer.refusal).toContain("archive.zip");
  });

  test("a document too large to download is refused before it is tried", () => {
    const answer = telegramFiles({
      document: {
        file_id: "p",
        file_name: "scan.pdf",
        mime_type: "application/pdf",
        file_size: 20 * 1024 * 1024,
      },
    });
    expect(answer.files).toEqual([]);
    expect(answer.refusal).toContain("9.5 MB");
  });

  test("a message with neither is no files and no refusal", () => {
    expect(telegramFiles({})).toEqual({ files: [] });
  });
});

describe("what the page is shown", () => {
  test("a picture is kept as it was uploaded", () => {
    expect(previewOf("image/jpeg", "abcd")).toBe("abcd");
  });

  test("a document is not kept, and neither is a picture too large to", () => {
    expect(previewOf("application/pdf", "abcd")).toBe("");
    expect(previewOf("image/png", "a".repeat(MAX_PREVIEW_CHARS + 1))).toBe("");
  });

  test("stored details read back, and anything damaged reads as none", () => {
    expect(
      parseDetail(
        '[{"id":7,"name":"photo.jpg","kind":"image","preview":true}]',
      ),
    ).toEqual([{ id: 7, name: "photo.jpg", kind: "image", preview: true }]);
    expect(parseDetail("")).toEqual([]);
    expect(parseDetail("not json")).toEqual([]);
    expect(parseDetail(undefined)).toEqual([]);
  });

  test("a preview without a row to fetch it from is not offered", () => {
    expect(
      parseDetail('[{"id":0,"name":"a.png","kind":"image","preview":true}]'),
    ).toEqual([{ id: 0, name: "a.png", kind: "image", preview: false }]);
  });
});
