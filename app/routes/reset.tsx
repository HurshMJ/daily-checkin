import { data, Form, redirect } from "react-router";

import { clearedCookie, readCookie, RESET_COOKIE, setCookies } from "~/auth/request";
import { createResetLinks } from "~/auth/reset-links";
import { PASSWORD_LENGTH_HINT } from "~/auth/rules";
import { FieldError } from "~/components/field-error";
import { Notice } from "~/components/notice";
import { OfflineBar } from "~/components/offline-bar";
import { SubmitButton, useSubmitting } from "~/components/submit-button";
import { appContext } from "~/services";

import type { Route } from "./+types/reset";

export const UNUSABLE_RESET_LINK_MESSAGE =
  "This Password Reset Link does not work. It may be used, cancelled, replaced or more than an hour old. Ask an Owner of your Group for a new one.";

export const PASSWORDS_DIFFER_MESSAGE = "The two passwords are not the same.";

// The page acts on a secret link: never send its URL on to another site, never cache it.
export function headers(_: Route.HeadersArgs) {
  return { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };
}

export function meta(_: Route.MetaArgs) {
  return [{ title: "Set a new password · Daily Check-in" }];
}

type PasswordErrors = Partial<Record<"newPassword" | "confirmPassword", string>>;

type ActionResult = { usable: false } | { usable: true; username: string; errors: PasswordErrors };

export async function loader({ request, context }: Route.LoaderArgs) {
  const token = readCookie(request, RESET_COOKIE);
  const view = token === null ? null : await createResetLinks(context.get(appContext)).view(token);
  return data(view ? { usable: true as const, username: view.username } : { usable: false as const }, {
    status: view ? 200 : 404,
  });
}

/**
 * Sets the password through the link in the cookie. Typed passwords are
 * never sent back to the page. On success the cookie is cleared and the
 * Member goes to log in with the new password.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const token = readCookie(request, RESET_COOKIE);
  const links = createResetLinks(context.get(appContext));
  const view = token === null ? null : await links.view(token);
  if (token === null || view === null) return data<ActionResult>({ usable: false }, { status: 404 });

  const form = await request.formData();
  const typed = String(form.get("newPassword") ?? "");
  const refused = (errors: PasswordErrors) =>
    data<ActionResult>({ usable: true, username: view.username, errors }, { status: 400 });
  if (typed !== String(form.get("confirmPassword") ?? "")) return refused({ confirmPassword: PASSWORDS_DIFFER_MESSAGE });

  const result = await links.setPassword(token, typed);
  if (result.ok) {
    return redirect("/login?notice=password-set", { headers: setCookies(clearedCookie(RESET_COOKIE)) });
  }
  if (result.reason === "unusable") return data<ActionResult>({ usable: false }, { status: 404 });
  return refused({ newPassword: result.message });
}

/** Set a new password: names the username and warns that every device is logged out. It has no top bar. */
export default function SetNewPassword({ loaderData, actionData }: Route.ComponentProps) {
  const state = actionData ?? loaderData;
  const submitting = useSubmitting();

  if (!state.usable) {
    return (
      <>
        <OfflineBar />
        <main className="page">
          <header className="setup-header">
            <h1>Set a new password</h1>
          </header>
          <Notice tone="error" title="Can't use this link">
            {UNUSABLE_RESET_LINK_MESSAGE}
          </Notice>
        </main>
      </>
    );
  }

  const errors: PasswordErrors = actionData && actionData.usable ? actionData.errors : {};
  return (
    <>
      <OfflineBar />
      <main className="page">
        <header className="setup-header">
          <h1>Set a new password</h1>
          <p className="setup-note">For @{state.username}.</p>
        </header>
        <Notice tone="warning" title="Every device is logged out">
          Setting a new password logs out @{state.username} on every device, then you log in again.
        </Notice>
        <Form method="post" className="page-form" noValidate>
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
              <p id="new-password-help" className="field-hint">{PASSWORD_LENGTH_HINT}</p>
            )}
          </div>
          <div className="field">
            <label className="field-label" htmlFor="confirm-password">New password again</label>
            <input
              className="field-input"
              id="confirm-password"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              aria-invalid={errors.confirmPassword ? true : undefined}
              aria-describedby={errors.confirmPassword ? "confirm-password-error" : undefined}
            />
            {errors.confirmPassword ? (
              <FieldError id="confirm-password-error">{errors.confirmPassword}</FieldError>
            ) : null}
          </div>
          <SubmitButton
            pending={submitting}
            label="Set password"
            pendingLabel="Setting password…"
            className="btn-primary"
          />
        </Form>
      </main>
    </>
  );
}
