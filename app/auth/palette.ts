/**
 * The 8 avatar colours. D1 stores the name; the shade lives only here, so it
 * can change without touching data. None is green, amber or red, which are
 * kept for Yes, Maybe and No.
 */
export const AVATAR_COLOURS = {
  blue: { label: "Blue", hex: "#2563eb" },
  sky: { label: "Sky", hex: "#0284c7" },
  cyan: { label: "Cyan", hex: "#0891b2" },
  indigo: { label: "Indigo", hex: "#4f46e5" },
  violet: { label: "Violet", hex: "#7c3aed" },
  purple: { label: "Purple", hex: "#9333ea" },
  pink: { label: "Pink", hex: "#db2777" },
  slate: { label: "Slate", hex: "#475569" },
} as const;

export type AvatarColour = keyof typeof AVATAR_COLOURS;

export const AVATAR_COLOUR_NAMES = Object.keys(AVATAR_COLOURS) as AvatarColour[];

export function isAvatarColour(value: unknown): value is AvatarColour {
  return typeof value === "string" && Object.hasOwn(AVATAR_COLOURS, value);
}
