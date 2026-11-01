import { Form, Link } from "react-router";

import { requireMember } from "~/auth/request";

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
  return (
    <main>
      <h1>Profile</h1>
      <p>Logged in as {loaderData.username}.</p>
      <Form method="post" action="/logout">
        <button type="submit">Log out</button>
      </Form>
      <p>
        <small>Log out ends the login on this device only.</small>
      </p>
      <Form method="post" action="/logout-everywhere">
        <button type="submit">Log out everywhere</button>
      </Form>
      <p>
        <small>Log out everywhere ends the login on all your devices, including this one.</small>
      </p>
      <p>
        <Link to="/">Back to Tonight</Link>
      </p>
    </main>
  );
}
