/**
 * Pictures and documents sent with a prompt.
 *
 * The page uploads them with the prompt; the run uploads each once to the
 * person's Anthropic Files API and the conversation holds only the file id.
 * The conversation is resent every turn, so a photo held inline would travel
 * through the script, and the request, on every one of them.
 */

/** What the Messages API reads, and as which kind of block. */
const KINDS: Record<string, "image" | "document"> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/gif": "image",
  "image/webp": "image",
  "application/pdf": "document",
  "text/plain": "document",
};

/** More than this in one prompt is more than a person means to send. */
export const MAX_ATTACHMENTS = 5;

/** A content block, as much of one as this module builds. */
export interface Block {
  type: string;
  [key: string]: unknown;
}

export interface Attachment {
  /** The name the person's file had, for the log and the document title. */
  name: string;
  contentType: string;
  fileId: string;
  /**
   * The bytes as base64, held only while the prompt is stored so the page's
   * copy can be kept. Never part of a block.
   */
  data?: string;
}

/** Which block a media type becomes, or null when the model cannot read it. */
export function attachmentKind(
  contentType: string,
): "image" | "document" | null {
  const bare = contentType.split(";")[0].trim().toLowerCase();
  return KINDS[bare] ?? null;
}

/** The content block that puts an uploaded file in front of the model. */
export function blockFor(attachment: Attachment): Block {
  const source = { type: "file", file_id: attachment.fileId };
  if (attachmentKind(attachment.contentType) === "image") {
    return { type: "image", source };
  }
  return { type: "document", source, title: attachment.name };
}

/**
 * The user message for a prompt: attachments first, then the words. The
 * API reads a picture placed before the question about it best, and a prompt
 * that is only attachments is still a message.
 */
export function promptBlocks(
  prompt: string,
  attachments: Attachment[],
): Block[] {
  const blocks = attachments.map(blockFor);
  if (prompt) blocks.push({ type: "text", text: prompt });
  return blocks;
}

/**
 * The original names, in upload order. The page sends them beside the files
 * because the engine accepts only plain file names on an upload, so the name
 * on the upload itself is a cleaned copy.
 */
export function originalNames(
  raw: string | undefined,
  count: number,
): string[] {
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(raw ?? "[]");
  } catch (e) {
    parsed = [];
  }
  const names = Array.isArray(parsed) ? parsed : [];
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = typeof names[i] === "string" ? names[i].trim() : "";
    result.push(name.slice(0, 200) || "attachment-" + (i + 1));
  }
  return result;
}

/** One line for the activity log naming what was sent. */
export function describeAttachments(attachments: Attachment[]): string {
  return attachments
    .map(
      (a) =>
        a.name +
        (attachmentKind(a.contentType) === "image"
          ? " (picture)"
          : " (document)"),
    )
    .join(", ");
}

/**
 * Every file one prompt may carry, together. The engine answers a `fetch`
 * of at most 10 MB, so a file downloaded from Telegram has to fit in that,
 * and the page keeps to the same figure.
 */
export const MAX_ATTACHMENT_BYTES = 9.5 * 1024 * 1024;

/**
 * The largest single picture. The Messages API refuses an image over 10 MB
 * once base64-encoded, which is 7.5 MB of bytes; this keeps under that with
 * room to spare. A picture larger than the model reads in pixels is scaled
 * down by the API, so only bytes need checking here.
 */
export const MAX_IMAGE_BYTES = 7 * 1024 * 1024;

/** The long edge the model reads a picture at; anything larger is scaled down. */
export const IMAGE_EDGE = 1568;

/**
 * Why a file is too large for the model, or "" when it is not. `base64Chars`
 * is the length of its base64, which is how the script holds a file.
 */
export function tooLargeToRead(
  name: string,
  contentType: string,
  base64Chars: number,
): string {
  if (attachmentKind(contentType) !== "image") return "";
  // Compared as base64, which pads to whole groups of four.
  if (base64Chars <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return "";
  return `${name} is a picture larger than the 7 MB the model reads`;
}

interface TelegramPhotoSize {
  file_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
}

interface TelegramDocument {
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** A file a Telegram message carries, before it has been downloaded. */
export interface TelegramFile {
  telegramId: string;
  name: string;
  contentType: string;
}

/**
 * The files in a Telegram message, or why they cannot be read.
 *
 * Telegram sends a photo at several sizes. The largest the model will read
 * whole is the one worth downloading: a larger one is only bytes, and a
 * smaller one loses detail. Telegram re-encodes every photo as JPEG.
 */
export function telegramFiles(message: {
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
}): { files: TelegramFile[]; refusal?: string } {
  const files: TelegramFile[] = [];

  const sizes = (message.photo ?? []).filter((size) => size.file_id);
  if (sizes.length > 0) {
    const edge = (size: TelegramPhotoSize) =>
      Math.max(Number(size.width ?? 0), Number(size.height ?? 0));
    const fitting = sizes.filter((size) => edge(size) <= IMAGE_EDGE);
    const chosen =
      fitting.length > 0
        ? fitting.reduce((a, b) => (edge(b) > edge(a) ? b : a))
        : sizes.reduce((a, b) => (edge(b) < edge(a) ? b : a));
    files.push({
      telegramId: String(chosen.file_id),
      name: "photo.jpg",
      contentType: "image/jpeg",
    });
  }

  const document = message.document;
  if (document?.file_id) {
    const name = String(document.file_name ?? "document").slice(0, 200);
    const contentType = String(document.mime_type ?? "");
    if (!attachmentKind(contentType)) {
      return {
        files: [],
        refusal: `I can read pictures, PDFs and plain-text files, and ${name} is none of those.`,
      };
    }
    if (Number(document.file_size ?? 0) > MAX_ATTACHMENT_BYTES) {
      return {
        files: [],
        refusal: `${name} is larger than the 9.5 MB I can take.`,
      };
    }
    // A photo sent as a file arrives as it was taken, not shrunk the way
    // Telegram shrinks a photo.
    if (
      attachmentKind(contentType) === "image" &&
      Number(document.file_size ?? 0) > MAX_IMAGE_BYTES
    ) {
      return {
        files: [],
        refusal: `${name} is a picture larger than the 7 MB I can read. Send it as a photo rather than as a file, and Telegram will shrink it.`,
      };
    }
    files.push({ telegramId: String(document.file_id), name, contentType });
  }

  return { files };
}

/**
 * The largest picture kept for showing on the page, as base64. A picture the
 * model reads is at most 1568 pixels on its long edge, which is nearly always
 * well under this; a larger one is shown by name only.
 */
export const MAX_PREVIEW_CHARS = 700 * 1024;

/** What the page needs to show one attachment in the log. */
export interface AttachmentDetail {
  /** The row holding the agent's own copy; 0 when none was kept. */
  id: number;
  name: string;
  kind: "image" | "document";
  /** Whether the page can ask for the picture. */
  preview: boolean;
}

/**
 * The copy kept for the page: the picture as uploaded, or nothing.
 *
 * The Files API will not hand back a file that was uploaded to it, only ones
 * its tools made, so the page can be shown a picture only if the agent keeps
 * one. Documents are not kept; their name is what the log shows.
 */
export function previewOf(contentType: string, data: string): string {
  if (attachmentKind(contentType) !== "image") return "";
  return data.length <= MAX_PREVIEW_CHARS ? data : "";
}

/** The details stored beside an activity, read back defensively. */
export function parseDetail(raw: unknown): AttachmentDetail[] {
  if (typeof raw !== "string" || !raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((d) => d && typeof d === "object")
    .map((d) => ({
      id: Number(d.id) > 0 ? Number(d.id) : 0,
      name: String(d.name ?? ""),
      kind: d.kind === "image" ? "image" : "document",
      preview: d.preview === true && Number(d.id) > 0,
    }));
}

/** Where a refused block sits: its message in the request, and its place there. */
export interface RefusedBlock {
  message: number;
  block: number;
}

interface SentMessage {
  role: string;
  content: Block[];
}

/** A picture or document the person sent, as opposed to anything else. */
function isAttachmentBlock(block: Block | undefined): boolean {
  return (
    !!block &&
    (block.type === "image" || block.type === "document") &&
    (block.source as { type?: string } | undefined)?.type === "file"
  );
}

function fileIdOf(block: Block): string {
  return String((block.source as { file_id?: unknown })?.file_id ?? "");
}

/**
 * The attachments a refusal from the Messages API is about, or none when it
 * is about something else.
 *
 * Read three ways, most certain first. The API names the block it refused by
 * its place — `messages.3.content.0.image.source: ...` — and `messages` is the
 * conversation as sent. Failing that, a refusal that quotes a file id is about
 * that file. Failing that, a refusal that speaks of an image or a document is
 * taken to be about the newest prompt's attachments, but only while nothing
 * has answered that prompt: a file the model has already read was readable.
 */
export function refusedAttachments(
  detail: string,
  messages: SentMessage[],
): RefusedBlock[] {
  const found: RefusedBlock[] = [];
  const named = /messages\.(\d+)\.content\.(\d+)/g;
  for (let match = named.exec(detail); match; match = named.exec(detail)) {
    const at = { message: Number(match[1]), block: Number(match[2]) };
    const already = found.some(
      (f) => f.message === at.message && f.block === at.block,
    );
    if (
      !already &&
      isAttachmentBlock(messages[at.message]?.content?.[at.block])
    ) {
      found.push(at);
    }
  }
  if (found.length > 0) return found;

  messages.forEach((message, m) => {
    (message.content ?? []).forEach((block, b) => {
      const id = isAttachmentBlock(block) ? fileIdOf(block) : "";
      if (id && detail.includes(id)) found.push({ message: m, block: b });
    });
  });
  if (found.length > 0) return found;

  if (!/\b(image|images|picture|pdf|document|file)\b/i.test(detail)) return [];
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m];
    if (message.role === "assistant") return [];
    const blocks = message.content ?? [];
    if (!blocks.some(isAttachmentBlock)) continue;
    return blocks.flatMap((block, b) =>
      isAttachmentBlock(block) ? [{ message: m, block: b }] : [],
    );
  }
  return [];
}

/** What a refused attachment is called in the note left in its place. */
export function refusedName(
  block: Block,
  names: Record<string, string>,
): string {
  const title = typeof block.title === "string" ? block.title : "";
  return (
    title ||
    names[fileIdOf(block)] ||
    (block.type === "image" ? "a picture" : "a document")
  );
}

/**
 * A message with the refused blocks replaced by a line saying what was there
 * and why it is gone, so the model can tell the person rather than answer as
 * if nothing had been sent.
 */
export function withoutRefused(
  content: Block[],
  refused: number[],
  names: Record<string, string>,
  reason: string,
): Block[] {
  return content.map((block, b) =>
    refused.includes(b)
      ? {
          type: "text",
          text: `[${refusedName(block, names)} was attached here, but the model API could not read it: ${reason}]`,
        }
      : block,
  );
}
