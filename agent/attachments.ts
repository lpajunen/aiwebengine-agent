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

/** The long edge the model reads a picture at; anything larger is scaled down. */
export const IMAGE_EDGE = 1568;

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
    files.push({ telegramId: String(document.file_id), name, contentType });
  }

  return { files };
}
