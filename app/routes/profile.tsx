import { data, Form } from "react-router";

import { clientIp } from "~/auth/login-limits";
import { authFor, currentSession, requireMember } from "~/auth/request";
import { AvatarDot } from "~/components/avatar-dot";
import { FieldError } from "~/components/field-error";
import { Notice } from "~/components/notice";
import { SubmitButton, useSubmitting } from "~/components/submit-button";
import { CONFIRM_FIELD, TapAgainButton } from "~/components/tap-again-button";
import { TopBar } from "~/components/top-bar";
import { appContext } from "~/services";

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

type PasswordErrors = Partial<Record<"currentPassword" | "newPassword", string>>;

/** Change password. Typed passwords are never sent back to the page. */
export async function action({ request, context }: Route.ActionArgs) {
  const member = requireMember(context);
  const token = currentSession(context)?.token ?? "";
  const form = await request.formData();

  const result = await authFor(context).changePassword(
    member,
    token,
    String(form.get("currentPassword") ?? ""),
    String(form.get("newPassword") ?? ""),
    clientIp(request),
  );
  if (result.ok) {
    return { errors: {} as PasswordErrors, changedAt: context.get(appContext).clock.now().toISOString() };
  }
  if (result.reason === "new-password") return passwordRefused({ newPassword: result.message }, 400);
  if (result.reason === "wrong-current") {
    return passwordRefused({ currentPassword: "That is not your current password." }, 400);
  }
  return passwordRefused({ currentPassword: "Too many wrong passwords. Try again later." }, 429);
}

function passwordRefused(errors: PasswordErrors, status: number) {
  return data({ errors, changedAt: null }, { status });
}

export default function Profile({ loaderData, actionData }: Route.ComponentProps) {
  const changingPassword = useSubmitting();
  const errors: PasswordErrors = actionData?.errors ?? {};
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
            password and sessions exist so far. */}
        <section className="card" aria-labelledby="password-heading">
          <h2 id="password-heading">Password</h2>
          <div role="status">
            {actionData?.changedAt ? (
              <Notice tone="info" title="Password changed">
                Your other devices are logged out.
              </Notice>
            ) : null}
          </div>
          {/* A new key after each change empties the fields. */}
          <Form method="post" className="page-form" noValidate key={actionData?.changedAt ?? "password"}>
            <div className="field">
              <label className="field-label" htmlFor="current-password">Current password</label>
              <input
                className="field-input"
                id="current-password"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
                aria-invalid={errors.currentPassword ? true : undefined}
                aria-describedby={errors.currentPassword ? "current-password-error" : undefined}
              />
              {errors.currentPassword ? (
                <FieldError id="current-password-error">{errors.currentPassword}</FieldError>
              ) : null}
            </div>
            <div className="field">
              <label className="field-label" htmlFor="new-password">New password</label>
              <input
                className="field-input"
                id="new-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                required
                aria-invalid={errors.newPassword ? true : undefined}
                aria-describedby="new-password-help"
              />
              {errors.newPassword ? (
                <FieldError id="new-password-help">{errors.newPassword}</FieldError>
              ) : (
                <p id="new-password-help" className="field-hint">Use 12 to 128 characters.</p>
              )}
            </div>
            <SubmitButton
              pending={changingPassword}
              label="Change password"
              pendingLabel="Changing password…"
              className="btn-primary"
            />
          </Form>
        </section>
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
