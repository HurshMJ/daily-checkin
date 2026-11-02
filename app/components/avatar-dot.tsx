import type { AvatarColour } from "~/auth/palette";

/** A Member's avatar dot. app.css maps data-colour to the --avatar-<name> token. */
export function AvatarDot({ colour }: { colour: AvatarColour }) {
  return <span className="avatar-dot" data-colour={colour} aria-hidden="true" />;
}
