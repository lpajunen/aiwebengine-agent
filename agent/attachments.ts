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
