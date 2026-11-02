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
    <main className="page">
      <header className="login-header">
        <h1>Daily Check-in</h1>
        <p className="login-tagline">Who's on tonight?</p>
      </header>
      {actionData?.error ? (
        <div className="notice-error" role="alert">
          <p className="notice-title">Can't log in</p>
          <p>{actionData.error}</p>
        </div>
      ) : null}
      <Form method="post" className="page-form">
        <div className="field">
          <label className="field-label" htmlFor="username">Username</label>
          <input
            className="field-input"
            id="username"
            name="username"
            autoComplete="username"
            required
            defaultValue={actionData?.username}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="password">Password</label>
          <input
            className="field-input"
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        <button className="btn-primary" type="submit">Log in</button>
      </Form>
      <p className="login-hint">No login yet? Ask a friend in your Group for an Invite.</p>
    </main>
  );
}
