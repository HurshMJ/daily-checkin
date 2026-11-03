import { Link } from "react-router";

import type { AvatarColour } from "~/auth/palette";

import { AvatarDot } from "./avatar-dot";
import { OfflineBar } from "./offline-bar";

/**
 * The bar above every logged-in screen: "‹ Tonight" on inner pages, and the
 * "You" pill with the Member's dot linking to the profile. The profile itself
 * passes no colour, so it never links to itself. The Offline bar sits
 * directly below it.
 */
export function TopBar({ back = false, colour }: { back?: boolean; colour?: AvatarColour }) {
  return (
    <>
      <header className="top-bar">
        {back ? (
          <Link to="/" className="top-bar-back">
            <span aria-hidden="true">‹</span> Tonight
          </Link>
        ) : null}
        {colour ? (
          <Link to="/profile" className="top-bar-you">
            <AvatarDot colour={colour} />
            You
          </Link>
        ) : null}
      </header>
      <OfflineBar />
    </>
  );
}
