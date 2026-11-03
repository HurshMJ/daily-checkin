import { describe, expect, it } from "vitest";

import manifestJson from "../public/manifest.webmanifest?raw";
import appleTouchIcon from "../public/apple-touch-icon.png?inline";
import icon192 from "../public/icon-192.png?inline";
import icon512 from "../public/icon-512.png?inline";

import { tokens } from "./tokens";

const manifest = JSON.parse(manifestJson);
const background = tokens.get("--bg");

/** Width, height and colour type from a PNG's IHDR chunk, read from a data URL. */
function pngHeader(dataUrl: string) {
  const [prefix, base64] = dataUrl.split(",");
  expect(prefix).toBe("data:image/png;base64");
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  // 8-byte signature, then the IHDR chunk: length, "IHDR", width, height, bit depth, colour type.
  expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(String.fromCharCode(...bytes.slice(12, 16))).toBe("IHDR");
  return { width: view.getUint32(16), height: view.getUint32(20), colourType: bytes[25] };
}

describe("web app manifest", () => {
  it("names the app and opens Tonight standalone", () => {
    expect(manifest.name).toBe("Daily Check-in");
    expect(manifest.short_name).toBe("Check-in");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  it("paints the theme and splash in the --bg colour from tokens.css", () => {
    expect(background).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toBe(background);
    expect(manifest.theme_color).toBe(background);
  });

  it("lists the 192 and 512 icons, with maskable as its own entry", () => {
    expect(manifest.icons).toEqual([
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ]);
  });
});

describe("icon files", () => {
  const files: Record<string, string> = {
    "/icon-192.png": icon192,
    "/icon-512.png": icon512,
    "/apple-touch-icon.png": appleTouchIcon,
  };

  it.each([
    ["/icon-192.png", 192],
    ["/icon-512.png", 512],
    ["/apple-touch-icon.png", 180],
  ])("%s is an opaque RGB PNG of %i pixels square", (src, size) => {
    const header = pngHeader(files[src]);
    expect(header.width).toBe(size);
    expect(header.height).toBe(size);
    // Colour type 2 is RGB with no alpha channel.
    expect(header.colourType).toBe(2);
  });

  it("covers every icon the manifest declares at its declared size", () => {
    for (const icon of manifest.icons as { src: string; sizes: string }[]) {
      const header = pngHeader(files[icon.src]);
      expect(`${header.width}x${header.height}`, icon.src).toBe(icon.sizes);
    }
  });
});
