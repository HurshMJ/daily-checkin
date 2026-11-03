import { requireMember } from "~/auth/request";
import { TopBar } from "~/components/top-bar";

import type { Route } from "./+types/home";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Tonight · Daily Check-in" }];
}

export function loader({ context }: Route.LoaderArgs) {
  const { colour } = requireMember(context);
  return { colour };
}

/** Tonight. A Member in no Group sees the empty state. */
export default function Tonight({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <TopBar colour={loaderData.colour} />
      <main className="page">
        <h1>Tonight</h1>
        <div className="card empty-state">
          <span className="empty-ring" aria-hidden="true" />
          <h2>You're not in a Group yet</h2>
          <p className="empty-hint">Create one and invite your friends, or open an Invite link a friend sent you.</p>
          {/* Wired up when Groups land. */}
          <button className="btn-primary" type="button">
            Create a Group
          </button>
        </div>
      </main>
    </>
  );
}
