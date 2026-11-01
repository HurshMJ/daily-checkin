import { Link } from "react-router";

import { AVATAR_COLOURS } from "~/auth/palette";
import { requireMember } from "~/auth/request";

import type { Route } from "./+types/home";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Tonight · Daily Check-in" }];
}

export function loader({ context }: Route.LoaderArgs) {
  const { username, colour } = requireMember(context);
  return { username, colour };
}

/** Tonight. A Member in no Group sees the empty state. */
export default function Tonight({ loaderData }: Route.ComponentProps) {
  return (
    <main>
      <p>
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: "0.8em",
            height: "0.8em",
            borderRadius: "50%",
            background: AVATAR_COLOURS[loaderData.colour].hex,
          }}
        />{" "}
        {loaderData.username} · <Link to="/profile">Profile</Link>
      </p>
      <h1>Tonight</h1>
      <p>You are not in a Group yet. Create one to start checking in with your friends.</p>
      {/* Wired up when Groups land. */}
      <button type="button">Create a Group</button>
    </main>
  );
}
