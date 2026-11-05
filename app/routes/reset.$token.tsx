import { moveTokenToCookie, RESET_COOKIE } from "~/auth/request";

import type { Route } from "./+types/reset.$token";

/** A Password Reset Link: moves its token into a cookie and goes on to /reset. Other methods get 405. */
export function loader({ params }: Route.LoaderArgs) {
  return moveTokenToCookie(params.token, RESET_COOKIE, "/reset");
}
