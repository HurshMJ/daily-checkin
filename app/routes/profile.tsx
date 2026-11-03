import { Form } from "react-router";

import { requireMember } from "~/auth/request";
import { AvatarDot } from "~/components/avatar-dot";
import { SubmitButton, useSubmitting } from "~/components/submit-button";
import { CONFIRM_FIELD, TapAgainButton } from "~/components/tap-again-button";
import { TopBar } from "~/components/top-bar";

import type { Route } from "./+types/profile";

const LOGOUT = "/logout";
const LOGOUT_EVERYWHERE = "/logout-everywhere";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Profile · Daily Check-in" }];
}

export function loader({ request, context }: Route.LoaderArgs) {
  const { username, colour } = requireMember(context);
  // Log out everywhere sends a first tap made without JavaScript back here, armed.
  const armLogoutEverywhere = new URL(request.url).searchParams.get(CONFIRM_FIELD) === "logout-everywhere";
  return { username, colour, armLogoutEverywhere };
}

export default function Profile({ loaderData }: Route.ComponentProps) {
  const loggingOut = useSubmitting(LOGOUT);
  const loggingOutEverywhere = useSubmitting(LOGOUT_EVERYWHERE);
  // Ticket 24 adds Display Name; until then the name is the username.
  const name = loaderData.username;
  return (
    <>
      <TopBar back />
      <main className="page">
        <header className="profile-header">
          <AvatarDot colour={loaderData.colour} size="large" />
          <div>
            <h1 className="profile-name">{name}</h1>
            <p className="profile-username">@{loaderData.username}</p>
          </div>
        </header>
        {/* One card per settings topic, in spec order: name and colour,
            notifications, password, Groups, sessions, delete login. Only
            sessions exists so far. */}
        <section className="card" aria-labelledby="sessions-heading">
          <h2 id="sessions-heading">Sessions</h2>
          <Form method="post" action={LOGOUT} className="card-action">
            <SubmitButton
              pending={loggingOut}
              label="Log out"
              pendingLabel="Logging out…"
              className="btn-secondary"
            />
            <p className="card-hint">Log out ends the login on this device only.</p>
          </Form>
          <Form method="post" action={LOGOUT_EVERYWHERE} className="card-action">
            <TapAgainButton
              pending={loggingOutEverywhere}
              label="Log out everywhere"
              confirmLabel="Tap again to log out every device"
              pendingLabel="Logging out…"
              armed={loaderData.armLogoutEverywhere}
            />
            <p className="card-hint">Log out everywhere ends the login on all your devices, including this one.</p>
          </Form>
        </section>
      </main>
    </>
  );
}
