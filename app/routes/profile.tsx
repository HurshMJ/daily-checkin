import { Form } from "react-router";

import { requireMember } from "~/auth/request";
import { SubmitButton, useSubmitting } from "~/components/submit-button";
import { TopBar } from "~/components/top-bar";

import type { Route } from "./+types/profile";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Profile · Daily Check-in" }];
}

export function loader({ context }: Route.LoaderArgs) {
  const { username } = requireMember(context);
  return { username };
}

// A minimal profile until the full one lands: just the two ways to log out.
export default function Profile({ loaderData }: Route.ComponentProps) {
  const loggingOut = useSubmitting("/logout");
  const loggingOutEverywhere = useSubmitting("/logout-everywhere");
  return (
    <>
      <TopBar back />
      <main>
        <h1>Profile</h1>
        <p>Logged in as {loaderData.username}.</p>
        <Form method="post" action="/logout">
          <SubmitButton
            pending={loggingOut}
            label="Log out"
            pendingLabel="Logging out…"
            className="btn-secondary"
          />
        </Form>
        <p>
          <small>Log out ends the login on this device only.</small>
        </p>
        <Form method="post" action="/logout-everywhere">
          <SubmitButton
            pending={loggingOutEverywhere}
            label="Log out everywhere"
            pendingLabel="Logging out…"
            className="btn-destructive"
          />
        </Form>
        <p>
          <small>Log out everywhere ends the login on all your devices, including this one.</small>
        </p>
      </main>
    </>
  );
}
