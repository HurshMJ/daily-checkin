import { AVATAR_COLOUR_NAMES, AVATAR_COLOURS } from "~/auth/palette";
import { type NewLoginErrors, PASSWORD_LENGTH_RANGE } from "~/auth/rules";

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
            {`${PASSWORD_LENGTH_RANGE}. A phrase with spaces works well.`}
          </p>
        )}
      </div>
      <ColourPicker error={errors.colour} colour={colour} />
    </>
  );
}

/**
 * The avatar colour picker: a radio tile per palette colour, each with its
 * dot and name, and the error below when there is one. Shared by new logins
 * and the profile's name and colour card.
 */
export function ColourPicker({ error, colour }: { error?: string; colour?: string }) {
  return (
    <fieldset
      className="picker"
      role="radiogroup"
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? "colour-error" : undefined}
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
      {error ? <FieldError id="colour-error">{error}</FieldError> : null}
    </fieldset>
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
