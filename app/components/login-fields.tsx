import { AVATAR_COLOUR_NAMES, AVATAR_COLOURS } from "~/auth/palette";
import type { NewLoginErrors } from "~/auth/rules";

import { AvatarDot } from "./avatar-dot";
import { FieldError } from "./field-error";

/**
 * The fields of a new login: username, password and the avatar colour
 * picker, each with its hint or its error. Shared by the Setup Link page and
 * the Invite page, so a new login looks and checks the same on both.
 */
export function NewLoginFields({
  errors,
  username,
  colour,
}: {
  errors: NewLoginErrors;
  username?: string;
  colour?: string;
}) {
  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor="username">Username</label>
        <input
          className="field-input"
          id="username"
          name="username"
          autoComplete="username"
          required
          defaultValue={username}
          aria-invalid={errors.username ? true : undefined}
          aria-describedby="username-help"
        />
        {errors.username ? (
          <FieldError id="username-help">{errors.username}</FieldError>
        ) : (
          <p id="username-help" className="field-hint">
            3 to 32 characters. Spaces and symbols are fine.
          </p>
        )}
      </div>
      <div className="field">
        <label className="field-label" htmlFor="password">Password</label>
        <input
          className="field-input"
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={errors.password ? true : undefined}
          aria-describedby="password-help"
        />
        {errors.password ? (
          <FieldError id="password-help">{errors.password}</FieldError>
        ) : (
          <p id="password-help" className="field-hint">
            12 to 128 characters. A phrase with spaces works well.
          </p>
        )}
      </div>
      <fieldset
        className="picker"
        role="radiogroup"
        aria-invalid={errors.colour ? true : undefined}
        aria-describedby={errors.colour ? "colour-error" : undefined}
      >
        <legend className="picker-legend">Avatar colour</legend>
        {AVATAR_COLOUR_NAMES.map((name) => (
          <label key={name} className="picker-tile">
            <input
              className="picker-input"
              type="radio"
              name="colour"
              value={name}
              required
              defaultChecked={colour === name}
            />
            <AvatarDot colour={name} />
            {AVATAR_COLOURS[name].label}
          </label>
        ))}
        {errors.colour ? <FieldError id="colour-error">{errors.colour}</FieldError> : null}
      </fieldset>
    </>
  );
}

/** The username and password fields of a login. Shared by the login page and the Invite page. */
export function LoginFields({ username }: { username?: string }) {
  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor="username">Username</label>
        <input
          className="field-input"
          id="username"
          name="username"
          autoComplete="username"
          required
          defaultValue={username}
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
    </>
  );
}
