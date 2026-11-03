import { moveTokenToCookie, SETUP_COOKIE } from "~/auth/request";

import type { Route } from "./+types/setup.$token";

/** A Setup Link: moves its token into a cookie and goes on to /setup. Other methods get 405. */
export function loader({ params }: Route.LoaderArgs) {
  return moveTokenToCookie(params.token, SETUP_COOKIE, "/setup");
}
