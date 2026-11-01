import { data, Form, redirect } from "react-router";

import { authFor, currentSession, sessionCookie } from "~/auth/request";

import type { Route } from "./+types/login";

// One message for every failure, so it never tells whether a username exists.
export const LOGIN_FAILED_MESSAGE = "That username and password do not match.";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Log in · Daily Check-in" }];
}

export function loader({ context }: Route.LoaderArgs) {
  if (currentSession(context)) throw redirect("/");
  return null;
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const username = String(form.get("username") ?? "");
  const password = String(form.get("password") ?? "");

  const token = await authFor(context).logIn(username, password);
  if (!token) return data({ error: LOGIN_FAILED_MESSAGE, username }, { status: 401 });
  return redirect("/", { headers: { "Set-Cookie": sessionCookie(token) } });
}

export default function Login({ actionData }: Route.ComponentProps) {
  return (
    <main>
      <h1>Log in</h1>
      {actionData?.error ? <p role="alert">{actionData.error}</p> : null}
      <Form method="post">
        <p>
          <label htmlFor="username">Username</label>
          <br />
          <input id="username" name="username" autoComplete="username" required defaultValue={actionData?.username} />
        </p>
        <p>
          <label htmlFor="password">Password</label>
          <br />
          <input id="password" name="password" type="password" autoComplete="current-password" required />
        </p>
        <p>
          <button type="submit">Log in</button>
        </p>
      </Form>
    </main>
  );
}
