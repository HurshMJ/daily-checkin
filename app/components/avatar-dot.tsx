import type { AvatarColour } from "~/auth/palette";

/**
 * A Member's avatar dot. app.css maps data-colour to the --avatar-<name>
 * token; the large size heads the profile.
 */
export function AvatarDot({ colour, size }: { colour: AvatarColour; size?: "large" }) {
  return (
    <span
      className={size === "large" ? "avatar-dot avatar-dot-large" : "avatar-dot"}
      data-colour={colour}
      aria-hidden="true"
    />
  );
}
