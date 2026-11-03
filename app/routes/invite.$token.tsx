import { INVITE_COOKIE, moveTokenToCookie } from "~/auth/request";

import type { Route } from "./+types/invite.$token";

/** An Invite link: moves its token into a cookie and goes on to /invite. Other methods get 405. */
export function loader({ params }: Route.LoaderArgs) {
  return moveTokenToCookie(params.token, INVITE_COOKIE, "/invite");
}
