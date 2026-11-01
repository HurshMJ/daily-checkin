import { data, Form, redirect } from "react-router";

import { AVATAR_COLOUR_NAMES, AVATAR_COLOURS } from "~/auth/palette";
import { authFor, sessionCookie } from "~/auth/request";
import { type NewLoginErrors, normaliseUsername, validateNewLogin } from "~/auth/rules";

import type { Route } from "./+types/setup.$token";

export const UNUSABLE_LINK_MESSAGE =
  "This Setup Link does not work. It may be used, replaced or more than an hour old. Ask the Operator for a new one.";

// The token is in the URL: never send it on to another site, never cache it.
export function headers(_: Route.HeadersArgs) {
  return { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };
}

export function meta(_: Route.MetaArgs) {
  return [{ title: "Create your login · Daily Check-in" }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const usable = await authFor(context).setupLinkIsUsable(params.token);
  return data({ usable }, { status: usable ? 200 : 404 });
}

interface ActionResult {
  usable: boolean;
  errors: NewLoginErrors;
  username: string;
  colour: string;
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const auth = authFor(context);
  const form = await request.formData();
  const echo = {
    username: normaliseUsername(String(form.get("username") ?? "")),
    colour: String(form.get("colour") ?? ""),
  };

  if (!(await auth.setupLinkIsUsable(params.token))) {
    return data<ActionResult>({ usable: false, errors: {}, ...echo }, { status: 404 });
  }
  const checked = validateNewLogin(form);
  if (!checked.ok) {
    return data<ActionResult>({ usable: true, errors: checked.errors, ...echo }, { status: 400 });
  }

  const result = await auth.createLoginFromSetupLink(params.token, checked.value);
  if (!result.ok) {
    const usable = result.reason !== "link-unusable";
    const errors = usable ? { username: "That username is taken." } : {};
    return data<ActionResult>({ usable, errors, ...echo }, { status: usable ? 400 : 404 });
  }
  return redirect("/", { headers: { "Set-Cookie": sessionCookie(result.sessionToken) } });
}

export default function SetupLink({ loaderData, actionData }: Route.ComponentProps) {
  const usable = actionData?.usable ?? loaderData?.usable ?? false;
  const errors = actionData?.errors ?? {};

  if (!usable) {
    return (
      <main>
        <h1>Create your login</h1>
        <p role="alert">{UNUSABLE_LINK_MESSAGE}</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Create your login</h1>
      <Form method="post" noValidate>
        <p>
          <label htmlFor="username">Username</label>
          <br />
          <input
            id="username"
            name="username"
            autoComplete="username"
            required
            defaultValue={actionData?.username}
            aria-invalid={errors.username ? true : undefined}
            aria-describedby="username-help"
          />
          <br />
          <span id="username-help">{errors.username ?? "3 to 32 characters. Spaces and symbols are fine."}</span>
        </p>
        <p>
          <label htmlFor="password">Password</label>
          <br />
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            aria-invalid={errors.password ? true : undefined}
            aria-describedby="password-help"
          />
          <br />
          <span id="password-help">
            {errors.password ?? "12 to 128 characters. A phrase with spaces works well."}
          </span>
        </p>
        <fieldset aria-describedby={errors.colour ? "colour-error" : undefined}>
          <legend>Avatar colour</legend>
          {AVATAR_COLOUR_NAMES.map((name) => (
            <label key={name} style={{ display: "inline-block", marginRight: "1em" }}>
              <input
                type="radio"
                name="colour"
                value={name}
                required
                defaultChecked={actionData?.colour === name}
              />{" "}
              <span
                aria-hidden="true"
                style={{
                  display: "inline-block",
                  width: "1em",
                  height: "1em",
                  borderRadius: "50%",
                  verticalAlign: "middle",
                  background: AVATAR_COLOURS[name].hex,
                }}
              />{" "}
              {AVATAR_COLOURS[name].label}
            </label>
          ))}
          {errors.colour ? <p id="colour-error">{errors.colour}</p> : null}
        </fieldset>
        <p>
          <button type="submit">Create login</button>
        </p>
      </Form>
    </main>
  );
}
