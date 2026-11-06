import { data, Form, Link, redirect, useNavigation } from "react-router";

import { hashToken } from "~/auth/crypto";
import { clientIp } from "~/auth/login-limits";
import { authFor, clearedSessionCookie, currentSession, requireMember } from "~/auth/request";
import { PASSWORD_LENGTH_HINT, type ProfileNamesErrors, shownName, validateProfileNames } from "~/auth/rules";
import { AvatarDot } from "~/components/avatar-dot";
import { FieldError } from "~/components/field-error";
import { ColourPicker } from "~/components/login-fields";
import { NotificationsCard, NOTIFICATIONS_INTENT, togglesFrom } from "~/components/notification-settings";
import { Notice } from "~/components/notice";
import { SubmitButton, useSubmitting } from "~/components/submit-button";
import { CONFIRM_FIELD, isConfirmed, TapAgainButton } from "~/components/tap-again-button";
import { TopBar } from "~/components/top-bar";
import { createGroups, type MembershipView, mustHandOver, type OwnedGroup } from "~/groups";
import { createPush } from "~/push";
import { appContext } from "~/services";

import type { Route } from "./+types/profile";

const LOGOUT = "/logout";
const LOGOUT_EVERYWHERE = "/logout-everywhere";
const NAMES_INTENT = "names";
const DELETE_LOGIN_INTENT = "delete-login";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Profile · Daily Check-in" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { id, username, displayName, colour } = requireMember(context);
  const app = context.get(appContext);
  const search = new URL(request.url).searchParams;
  // Log out everywhere sends a first tap made without JavaScript back here, armed.
  const armLogoutEverywhere = search.get(CONFIRM_FIELD) === "logout-everywhere";
  const push = createPush(app);
  const [groups, prefs, pushOnHere] = await Promise.all([
    createGroups(app).membershipsFor(id),
    push.prefsFor(id),
    push.sessionHasSubscription(await hashToken(currentSession(context)!.token)),
  ]);
  // Leaving a Group lands back here with the Group's name for the status line.
  const left = search.get("left");
  return {
    username,
    displayName,
    colour,
    // Saving the name and colour card lands back here, so the header and the
    // top bar read the saved names from a fresh session.
    namesSaved: search.has("saved"),
    armLogoutEverywhere,
    groups,
    left: left ? { name: left, deleted: search.has("deleted") } : null,
    notifications: {
      publicKey: app.env.VAPID_PUBLIC_KEY,
      onHere: pushOnHere,
      prefs,
    },
  };
}

type PasswordErrors = Partial<Record<"currentPassword" | "newPassword", string>>;

/** A refused name and colour save: the field errors and the values as typed, to fill the form again. */
interface NamesRefused {
  errors: ProfileNamesErrors;
  values: { username: string; displayName: string; colour: string };
}

/** A refused Delete login: the password field's error, or the Groups to hand over first. */
interface DeleteLoginRefused {
  error: string | null;
  groups: OwnedGroup[] | null;
}

/** What every action result holds when the post did not touch that card. */
const UNCHANGED = {
  errors: {} as PasswordErrors,
  changedAt: null as string | null,
  armedLeave: null as number | null,
  notificationsSaved: false,
  names: null as NamesRefused | null,
  deleteLogin: null as DeleteLoginRefused | null,
};

/**
 * Change password, save the name and colour card when the intent field is
 * "names", leave a Group when it is "leave", save the notification toggles
 * when it is "notifications", or delete the login when it is "delete-login".
 * Typed passwords are never sent back to the page. Leaving acts only when the tap-again button confirmed it; an
 * unconfirmed post returns the page with that Group's Leave button armed.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const member = requireMember(context);
  const token = currentSession(context)?.token ?? "";
  const form = await request.formData();

  if (form.get("intent") === NAMES_INTENT) {
    const valid = validateProfileNames(form);
    const result = valid.ok ? await authFor(context).saveProfileNames(member, valid.value, clientIp(request)) : valid;
    if (result.ok) return redirect("/profile?saved=1", 303);
    const values = {
      username: String(form.get("username") ?? ""),
      displayName: String(form.get("displayName") ?? ""),
      colour: String(form.get("colour") ?? ""),
    };
    return data({ ...UNCHANGED, names: { errors: result.errors, values } }, { status: 400 });
  }

  if (form.get("intent") === DELETE_LOGIN_INTENT) {
    const result = await authFor(context).deleteLogin(member, String(form.get("password") ?? ""), clientIp(request));
    if (result.ok) {
      return redirect("/login?notice=login-deleted", { headers: { "Set-Cookie": clearedSessionCookie() } });
    }
    const deleteLogin: DeleteLoginRefused =
      result.reason === "owns-groups"
        ? { error: null, groups: result.groups }
        : {
            error: result.reason === "limited" ? "Too many wrong passwords. Try again later." : "That is not your password.",
            groups: null,
          };
    const status = result.reason === "owns-groups" ? 409 : result.reason === "limited" ? 429 : 400;
    return data({ ...UNCHANGED, deleteLogin }, { status });
  }

  if (form.get("intent") === NOTIFICATIONS_INTENT) {
    await createPush(context.get(appContext)).setPrefs(member.id, togglesFrom(form));
    return { ...UNCHANGED, notificationsSaved: true };
  }

  if (form.get("intent") === "leave") {
    const groupId = Number(form.get("groupId"));
    if (!Number.isSafeInteger(groupId)) return refused({}, 400);
    if (!isConfirmed(form)) return { ...UNCHANGED, armedLeave: groupId };
    const groups = createGroups(context.get(appContext));
    const name = (await groups.membershipsFor(member.id)).find((group) => group.groupId === groupId)?.name;
    const left = await groups.leave(member.id, groupId);
    // A Member who is not in the Group gets 404; an Owner with other Members has no Leave button.
    if (!left.ok) return refused({}, left.reason === "not-member" ? 404 : 409);
    const search = new URLSearchParams({ left: name ?? "the Group" });
    if (left.deleted) search.set("deleted", "1");
    return redirect(`/profile?${search}`, 303);
  }

  const result = await authFor(context).changePassword(
    member,
    token,
    String(form.get("currentPassword") ?? ""),
    String(form.get("newPassword") ?? ""),
    clientIp(request),
  );
  if (result.ok) return { ...UNCHANGED, changedAt: context.get(appContext).clock.now().toISOString() };
  if (result.reason === "new-password") return refused({ newPassword: result.message }, 400);
  if (result.reason === "wrong-current") {
    return refused({ currentPassword: "That is not your current password." }, 400);
  }
  return refused({ currentPassword: "Too many wrong passwords. Try again later." }, 429);
}

/** A refused post: the password errors, if any, with nothing changed. */
function refused(errors: PasswordErrors, status: number) {
  return data({ ...UNCHANGED, errors }, { status });
}

export default function Profile({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  // The Groups card's Leave forms and the Notifications form post here too;
  // each button pends only for its own form's post.
  const submitting = useSubmitting();
  const intent = navigation.formData?.get("intent");
  const changingPassword =
    submitting &&
    intent !== "leave" &&
    intent !== NOTIFICATIONS_INTENT &&
    intent !== NAMES_INTENT &&
    intent !== DELETE_LOGIN_INTENT;
  const deletingLogin = submitting && intent === DELETE_LOGIN_INTENT;
  const savingNotifications = submitting && intent === NOTIFICATIONS_INTENT;
  const savingNames = submitting && intent === NAMES_INTENT;
  const errors: PasswordErrors = actionData?.errors ?? {};
  const loggingOut = useSubmitting(LOGOUT);
  const loggingOutEverywhere = useSubmitting(LOGOUT_EVERYWHERE);
  const name = shownName(loaderData);
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
            notifications, password, Groups, sessions, delete login. */}
        <NamesCard
          username={loaderData.username}
          displayName={loaderData.displayName}
          colour={loaderData.colour}
          saved={loaderData.namesSaved && !actionData}
          refused={actionData?.names ?? null}
          saving={savingNames}
        />
        <NotificationsCard
          {...loaderData.notifications}
          saved={actionData?.notificationsSaved ?? false}
          saving={savingNotifications}
        />
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
                <p id="new-password-help" className="field-hint">{PASSWORD_LENGTH_HINT}</p>
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
        <GroupsCard
          groups={loaderData.groups}
          left={loaderData.left}
          armed={actionData?.armedLeave ?? null}
        />
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
        <DeleteLoginCard
          handOver={
            actionData?.deleteLogin?.groups ??
            loaderData.groups.filter(mustHandOver).map((group) => ({ groupId: group.groupId, name: group.name }))
          }
          error={actionData?.deleteLogin?.error ?? null}
          deleting={deletingLogin}
        />
      </main>
    </>
  );
}

/**
 * The name and colour card: username, the optional Display Name and the
 * avatar colour, saved together. A refused save fills the fields again with
 * what was typed and puts each error next to its field.
 */
function NamesCard({
  username,
  displayName,
  colour,
  saved,
  refused,
  saving,
}: {
  username: string;
  displayName: string | null;
  colour: string;
  saved: boolean;
  refused: NamesRefused | null;
  saving: boolean;
}) {
  const errors = refused?.errors ?? {};
  const values = refused?.values ?? { username, displayName: displayName ?? "", colour };
  return (
    <section className="card" aria-labelledby="names-heading">
      <h2 id="names-heading">Name and colour</h2>
      <div role="status">
        {saved ? (
          <Notice tone="info" title="Profile saved">
            Your Groups see your new name and colour.
          </Notice>
        ) : null}
      </div>
      {/* A new key after each refused save fills the fields with what was typed. */}
      <Form method="post" className="page-form" noValidate key={refused ? JSON.stringify(refused) : "names"}>
        <input type="hidden" name="intent" value={NAMES_INTENT} />
        <div className="field">
          <label className="field-label" htmlFor="profile-username">Username</label>
          <input
            className="field-input"
            id="profile-username"
            name="username"
            autoComplete="username"
            required
            defaultValue={values.username}
            aria-invalid={errors.username ? true : undefined}
            aria-describedby="profile-username-help"
          />
          {errors.username ? (
            <FieldError id="profile-username-help">{errors.username}</FieldError>
          ) : (
            <p id="profile-username-help" className="field-hint">
              You log in with this. 3 to 32 characters.
            </p>
          )}
        </div>
        <div className="field">
          <label className="field-label" htmlFor="display-name">Display Name</label>
          <input
            className="field-input"
            id="display-name"
            name="displayName"
            autoComplete="nickname"
            defaultValue={values.displayName}
            aria-invalid={errors.displayName ? true : undefined}
            aria-describedby="display-name-help"
          />
          {errors.displayName ? (
            <FieldError id="display-name-help">{errors.displayName}</FieldError>
          ) : (
            <p id="display-name-help" className="field-hint">Leave empty to show your username.</p>
          )}
        </div>
        <ColourPicker error={errors.colour} colour={values.colour} />
        <SubmitButton pending={saving} label="Save" pendingLabel="Saving…" className="btn-primary" />
      </Form>
    </section>
  );
}

/**
 * Delete login: the password confirms it. While the Member owns a Group with
 * other Members, the card lists those Groups, linked to their pages where
 * Make Owner is, instead of the form.
 */
function DeleteLoginCard({
  handOver,
  error,
  deleting,
}: {
  handOver: OwnedGroup[];
  error: string | null;
  deleting: boolean;
}) {
  return (
    <section className="card" aria-labelledby="delete-login-heading">
      <h2 id="delete-login-heading">Delete login</h2>
      {handOver.length > 0 ? (
        <>
          <Notice tone="warning" title="Make another Member Owner first">
            You own Groups with other Members. Open each one and make another Member Owner, then delete your login.
          </Notice>
          <ul className="list" aria-label="Groups to hand over">
            {handOver.map((group) => (
              <li key={group.groupId} className="list-tile">
                <Link className="list-tile-name" to={`/groups/${group.groupId}`}>
                  {group.name}
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <Form method="post" className="page-form" noValidate>
          <input type="hidden" name="intent" value={DELETE_LOGIN_INTENT} />
          <p className="card-hint">
            Deletes your login, your Check-ins and your History rows for good, and any Group you are the only Member
            of. Nobody is told.
          </p>
          <div className="field">
            <label className="field-label" htmlFor="delete-password">Your password</label>
            <input
              className="field-input"
              id="delete-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "delete-password-error" : undefined}
            />
            {error ? <FieldError id="delete-password-error">{error}</FieldError> : null}
          </div>
          <SubmitButton
            pending={deleting}
            label="Delete login"
            pendingLabel="Deleting login…"
            className="btn-destructive"
          />
        </Form>
      )}
    </section>
  );
}

/**
 * The Member's Groups, each with Leave behind a tap-again button. An Owner
 * with other Members has no Leave button, only the hint to hand over first;
 * an Owner who is the last Member deletes the Group by leaving.
 */
function GroupsCard({
  groups,
  left,
  armed,
}: {
  groups: MembershipView[];
  left: { name: string; deleted: boolean } | null;
  armed: number | null;
}) {
  const navigation = useNavigation();
  const submitting = useSubmitting();
  const leaving = submitting && navigation.formData?.get("intent") === "leave" ? navigation.formData.get("groupId") : null;
  return (
    <section className="card" aria-labelledby="groups-heading">
      <h2 id="groups-heading">Groups</h2>
      <div role="status">
        {left ? (
          <Notice tone="info" title={left.deleted ? `You left and deleted ${left.name}` : `You left ${left.name}`}>
            {left.deleted ? "It was deleted for everyone." : "Its Board is off your Tonight."}
          </Notice>
        ) : null}
      </div>
      {groups.length === 0 ? (
        <p className="card-hint">You are not in any Group.</p>
      ) : (
        <ul className="list">
          {groups.map((group) => {
            const nameId = `group-${group.groupId}-name`;
            return (
              <li key={group.groupId} className="list-tile">
                <span className="list-tile-text">
                  <span className="list-tile-name" id={nameId}>
                    {group.name}
                  </span>
                  <span className="list-tile-detail">
                    {group.isOwner ? "Owner · " : ""}
                    {group.memberCount === 1 ? "1 Member" : `${group.memberCount} Members`}
                  </span>
                  {mustHandOver(group) ? (
                    <span className="list-tile-detail">Make another Member Owner first</span>
                  ) : null}
                </span>
                {mustHandOver(group) ? null : (
                  <Form method="post" className="list-tile-action">
                    <input type="hidden" name="intent" value="leave" />
                    <input type="hidden" name="groupId" value={group.groupId} />
                    <TapAgainButton
                      pending={leaving === String(group.groupId)}
                      label="Leave"
                      confirmLabel={group.isOwner ? `Tap again to leave and delete ${group.name}` : `Tap again to leave ${group.name}`}
                      pendingLabel="Leaving…"
                      armed={armed === group.groupId}
                      describedBy={nameId}
                    />
                  </Form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
