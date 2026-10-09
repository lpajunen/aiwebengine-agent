/**
 * Pictures the agent draws.
 */

import { MAX_PREVIEW_CHARS } from "./attachments.ts";
import {
  MAX_CAPTION_CHARS,
  RENDER_SIZES,
  renderSvg,
  telegramPhotoForm,
} from "./images.ts";

const DIAGRAM =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">' +
  '<rect x="10" y="10" width="80" height="80" fill="#e8f0fe" stroke="#1a73e8"/>' +
  '<text x="50" y="55" text-anchor="middle">A</text></svg>';

describe("rendering what the model drew", () => {
  test("an SVG becomes a PNG at the first size", () => {
    const rendered = renderSvg(DIAGRAM);
    if (!("png" in rendered)) throw new Error(rendered.error);
    expect(rendered.png.startsWith("iVBORw0KGgo")).toBe(true);
  });

  test("an SVG the engine cannot draw is an error the model can read", () => {
    const rendered = renderSvg("<svg");
    expect("error" in rendered).toBe(true);
    if ("error" in rendered) {
      expect(rendered.error.includes("not a renderable SVG")).toBe(true);
    }
  });

  test("an empty SVG is refused without asking the engine", () => {
    let asked = false;
    const rendered = renderSvg("  ", () => {
      asked = true;
      return "";
    });
    expect(asked).toBe(false);
    expect("error" in rendered).toBe(true);
  });

  test("a refusal about size tries the next size", () => {
    const tried: SvgToPngOptions[] = [];
    const rendered = renderSvg(DIAGRAM, (_, options) => {
      tried.push(options);
      if (tried.length === 1) {
        throw new Error(
          "convert.svg_to_png: output would be 1200×9000 px; each side may be at most 4096 px",
        );
      }
      return "iVBORw0KGgo";
    });
    expect(tried.length).toBe(2);
    expect(tried[1].height).toBe(RENDER_SIZES[1].height);
    expect("png" in rendered).toBe(true);
  });

  test("a PNG too large to keep tries a smaller size, then gives up", () => {
    let calls = 0;
    const rendered = renderSvg(DIAGRAM, () => {
      calls += 1;
      return "x".repeat(MAX_PREVIEW_CHARS + 1);
    });
    expect(calls).toBe(RENDER_SIZES.length);
    expect("error" in rendered).toBe(true);
  });

  test("any other refusal is answered at once", () => {
    let calls = 0;
    const rendered = renderSvg(DIAGRAM, () => {
      calls += 1;
      throw new Error("convert.svg_to_png: rendering took longer than 5000 ms");
    });
    expect(calls).toBe(1);
    expect("error" in rendered).toBe(true);
  });

  test("every size has a white background", () => {
    for (const size of RENDER_SIZES) expect(size.background).toBe("white");
  });
});

describe("the Telegram photo", () => {
  test("carries the chat, the PNG and the caption", () => {
    const parts = telegramPhotoForm("42", "iVBOR", "A diagram");
    expect(parts.length).toBe(3);
    expect(parts[0]).toEqual({ name: "chat_id", value: "42" });
    expect(parts[1].base64).toBe("iVBOR");
    expect(parts[1].contentType).toBe("image/png");
    expect(parts[2]).toEqual({ name: "caption", value: "A diagram" });
  });

  test("an empty caption is left out and a long one is cut", () => {
    expect(telegramPhotoForm("42", "iVBOR", "  ").length).toBe(2);
    const long = telegramPhotoForm("42", "iVBOR", "x".repeat(2000));
    expect(String(long[2].value).length).toBe(MAX_CAPTION_CHARS);
  });
});
