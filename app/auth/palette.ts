/**
 * The 8 avatar colours. D1 stores the name; the shade lives only in
 * app/styles/tokens.css (--avatar-<name>), so it can change without touching
 * data. None is green, amber or red, which are kept for Yes, Maybe and No.
 */
export const AVATAR_COLOURS = {
  blue: { label: "Blue" },
  sky: { label: "Sky" },
  cyan: { label: "Cyan" },
  indigo: { label: "Indigo" },
  violet: { label: "Violet" },
  purple: { label: "Purple" },
  pink: { label: "Pink" },
  slate: { label: "Slate" },
} as const;

export type AvatarColour = keyof typeof AVATAR_COLOURS;

export const AVATAR_COLOUR_NAMES = Object.keys(AVATAR_COLOURS) as AvatarColour[];

export function isAvatarColour(value: unknown): value is AvatarColour {
  return typeof value === "string" && Object.hasOwn(AVATAR_COLOURS, value);
}
