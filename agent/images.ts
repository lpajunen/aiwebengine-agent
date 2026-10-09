/**
 * Pictures the agent draws: an SVG the model wrote, turned into a PNG the
 * person can see on the page and in Telegram.
 *
 * Only the PNG is kept. The SVG is model-written and so steerable by anything
 * the model read; served as `image/svg+xml` it would be a document able to
 * carry script, and rendered to pixels it carries nothing. Rendering it first
 * also checks it: an SVG the engine cannot draw goes back to the model as an
 * error it can fix, rather than reaching the person as a broken picture.
 */

import { MAX_PREVIEW_CHARS } from "./attachments.ts";

/**
 * The sizes tried, in order. Wide enough to read on a phone and to survive
 * Telegram's resize; then a tall drawing by its height, which at 1200 wide
 * would pass the engine's longest side; then smaller, for a busy picture
 * whose PNG is too large to keep. White behind, because Telegram flattens
 * transparency to black.
 */
export const RENDER_SIZES: SvgToPngOptions[] = [
  { width: 1200, background: "white" },
  { height: 1600, background: "white" },
  { width: 800, background: "white" },
];

/** Telegram's limit on a photo's caption. */
export const MAX_CAPTION_CHARS = 1024;

export type Rendered = { png: string } | { error: string };

/** An engine refusal about the output's size, which a smaller size cures. */
function aboutSize(message: string): boolean {
  return /each side|pixels in all/.test(message);
}

/**
 * Render `svg` at the first size that the engine accepts and that is small
 * enough to keep. Anything else the engine refuses is the SVG's fault and is
 * answered at once, with the engine's reason.
 */
export function renderSvg(
  svg: string,
  render: (svg: string, options: SvgToPngOptions) => string = (s, o) =>
    convert.svg_to_png(s, o),
): Rendered {
  if (!svg.trim()) return { error: "The SVG is empty." };
  for (const size of RENDER_SIZES) {
    let png: string;
    try {
      png = render(svg, size);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (aboutSize(message)) continue;
      return { error: message };
    }
    if (png.length <= MAX_PREVIEW_CHARS) return { png: png };
  }
  return {
    error:
      "The picture is too large to show at any size tried. Simplify it — fewer elements, no embedded detail — and try again.",
  };
}

/** The `sendPhoto` form for a rendered picture. */
export function telegramPhotoForm(
  chatId: string,
  png: string,
  caption: string,
): FormPart[] {
  const parts: FormPart[] = [
    { name: "chat_id", value: chatId },
    {
      name: "photo",
      base64: png,
      filename: "picture.png",
      contentType: "image/png",
    },
  ];
  const text = caption.trim();
  if (text) {
    parts.push({
      name: "caption",
      value:
        text.length <= MAX_CAPTION_CHARS
          ? text
          : text.slice(0, MAX_CAPTION_CHARS - 1) + "…",
    });
  }
  return parts;
}
