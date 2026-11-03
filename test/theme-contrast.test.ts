import { describe, expect, it } from "vitest";

import { AVATAR_COLOUR_NAMES } from "~/auth/palette";
import tokensCss from "~/styles/tokens.css?raw";

/**
 * Every colour pair the design uses, with the WCAG 2.2 AA ratio it must reach:
 * 4.5 for text, 3 for large text, borders, stripes, focus, avatar dots and
 * disabled text. Names are the custom properties in app/styles/tokens.css.
 */
const TEXT = 4.5;
const NON_TEXT = 3;

type Pair = [foreground: string, background: string, ratio: number, use: string];

const PAIRS: Pair[] = [
  ...["--bg", "--surface", "--row"].flatMap((bg): Pair[] => [
    ["--text", bg, TEXT, "text"],
    ["--text-secondary", bg, TEXT, "secondary text"],
    ["--control-border", bg, NON_TEXT, "outline of a field or secondary button"],
  ]),
  ["--accent", "--surface", TEXT, "link on a card"],
  ["--accent", "--bg", TEXT, "link on the page"],
  ["--accent", "--bg", NON_TEXT, "focus outline"],
  ...["--yes", "--maybe", "--no"].flatMap((answer): Pair[] => [
    [answer, "--row", TEXT, "Availability word on a row"],
    [answer, "--surface", TEXT, "Availability word on a card"],
    [answer, "--row", NON_TEXT, "Availability stripe on a row"],
  ]),
  ["--accent", "--row", NON_TEXT, "information notice stripe"],
  ["--maybe", "--row", NON_TEXT, "warning notice stripe"],
  ["--no", "--row", NON_TEXT, "error notice stripe"],
  ["--no", "--bg", TEXT, "destructive button and field error line"],
  ["--no", "--surface", TEXT, "destructive button on a card"],
  ["--no", "--bg", NON_TEXT, "field error border"],
  ["--no", "--destructive-pressed", TEXT, "pressed destructive button"],
  ["--text", "--secondary-pressed", TEXT, "pressed secondary button"],
  ...["--yes", "--maybe", "--no", "--accent", "--primary-pressed"].map(
    (fill): Pair => ["--on-fill", fill, TEXT, "dark text on a fill"],
  ),
  ["--on-fill", "--maybe", TEXT, "offline bar"],
  ["--no-answer", "--surface", NON_TEXT, "No answer yet dashes"],
  ["--disabled-text", "--disabled-fill", NON_TEXT, "disabled text"],
  ...AVATAR_COLOUR_NAMES.flatMap((name) =>
    ["--bg", "--surface", "--row"].map((bg): Pair => [`--avatar-${name}`, bg, NON_TEXT, "avatar dot"]),
  ),
];

/** Reads every custom property in a stylesheet as name and raw value. */
function customProperties(css: string): Map<string, string> {
  const props = new Map<string, string>();
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    props.set(match[1], match[2].trim());
  }
  return props;
}

const HEX = /^#[0-9a-f]{6}$/i;

const LENGTH = /^-?\d*\.?\d+(px|rem|em|%)$/;
const NUMBER = /^-?\d*\.?\d+$/;
const DURATION = /^\d*\.?\d+m?s$/;

/**
 * A custom property is a colour unless it is a font stack (named --font-*), a
 * length, a number or a duration. Every colour must then be literal #rrggbb,
 * so a named colour, hwb() or var() cannot slip past the contrast checks.
 */
function isColourToken(name: string, value: string): boolean {
  if (name.startsWith("--font-")) return false;
  return ![LENGTH, NUMBER, DURATION].some((form) => form.test(value));
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const tokens = customProperties(tokensCss);

function colour(name: string): string {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`${name} is not defined in tokens.css`);
  if (!HEX.test(value)) throw new Error(`${name} is ${value}, not a literal #rrggbb colour`);
  return value;
}

describe("contrast helper", () => {
  it("matches the WCAG reference values", () => {
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrast("#123456", "#123456")).toBe(1);
  });

  it("rejects a colour token that is not literal hex", () => {
    const fake = customProperties(":root { --ok: #a1b2c3; --bad: var(--ok); --short: #abc; }");
    expect(HEX.test(fake.get("--ok") ?? "")).toBe(true);
    expect(HEX.test(fake.get("--bad") ?? "")).toBe(false);
    expect(HEX.test(fake.get("--short") ?? "")).toBe(false);
  });

  it("treats every token that is not a font stack, length, number or duration as a colour", () => {
    const fake = customProperties(
      `:root { --named: red; --wide: hwb(270 20% 10%); --font-x: "A B", system-ui, sans-serif;
        --size-x: 1.25rem; --radius-x: 28px; --pill: 999px; --ratio: 1.5; --wait: 150ms; }`,
    );
    const colours = [...fake].filter(([name, value]) => isColourToken(name, value)).map(([name]) => name);
    expect(colours).toEqual(["--named", "--wide"]);
    for (const name of colours) expect(fake.get(name)).not.toMatch(HEX);
  });
});

describe("theme tokens", () => {
  it("writes every colour token as a literal #rrggbb value", () => {
    const colourNames = new Set(PAIRS.flatMap(([fg, bg]) => [fg, bg]));
    for (const name of colourNames) expect(() => colour(name), name).not.toThrow();

    for (const [name, value] of tokens) {
      if (isColourToken(name, value)) expect(value, name).toMatch(HEX);
    }
  });

  it.each(PAIRS)("%s on %s reaches %s:1 (%s)", (fg, bg, ratio) => {
    expect(contrast(colour(fg), colour(bg))).toBeGreaterThanOrEqual(ratio);
  });
});
