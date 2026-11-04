import { data, Form, redirect, useNavigation } from "react-router";

import { hashToken } from "~/auth/crypto";
import { clientIp } from "~/auth/login-limits";
import { authFor, currentSession, requireMember } from "~/auth/request";
import { AvatarDot } from "~/components/avatar-dot";
import { FieldError } from "~/components/field-error";
import { NotificationsCard, NOTIFICATIONS_INTENT, togglesFrom } from "~/components/notification-settings";
import { Notice } from "~/components/notice";
import { SubmitButton, useSubmitting } from "~/components/submit-button";
import { CONFIRM_FIELD, isConfirmed, TapAgainButton } from "~/components/tap-again-button";
import { TopBar } from "~/components/top-bar";
import { createGroups, type MembershipView } from "~/groups";
import { createPush } from "~/push";
import { appContext } from "~/services";

import type { Route } from "./+types/profile";

const LOGOUT = "/logout";
const LOGOUT_EVERYWHERE = "/logout-everywhere";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Profile · Daily Check-in" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { id, username, colour } = requireMember(context);
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
    colour,
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

/**
 * Change password, leave a Group when the intent field is "leave", or save
 * the notification toggles when it is "notifications". Typed passwords are
 * never sent back to the page. Leaving acts only when the tap-again button
 * confirmed it; an unconfirmed post returns the page with that Group's Leave
 * button armed.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const member = requireMember(context);
  const token = currentSession(context)?.token ?? "";
  const form = await request.formData();

  if (form.get("intent") === NOTIFICATIONS_INTENT) {
    await createPush(context.get(appContext)).setPrefs(member.id, togglesFrom(form));
    return { errors: {} as PasswordErrors, changedAt: null, armedLeave: null, notificationsSaved: true };
  }

  if (form.get("intent") === "leave") {
    const groupId = Number(form.get("groupId"));
    if (!Number.isSafeInteger(groupId)) return refused({}, 400);
    if (!isConfirmed(form)) return { errors: {} as PasswordErrors, changedAt: null, armedLeave: groupId, notificationsSaved: false };
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
  if (result.ok) {
    return {
      errors: {} as PasswordErrors,
      changedAt: context.get(appContext).clock.now().toISOString(),
      armedLeave: null,
      notificationsSaved: false,
    };
  }
  if (result.reason === "new-password") return refused({ newPassword: result.message }, 400);
  if (result.reason === "wrong-current") {
    return refused({ currentPassword: "That is not your current password." }, 400);
  }
  return refused({ currentPassword: "Too many wrong passwords. Try again later." }, 429);
}

/** A refused post: the password errors, if any, with nothing changed. */
function refused(errors: PasswordErrors, status: number) {
  return data({ errors, changedAt: null, armedLeave: null, notificationsSaved: false }, { status });
}

export default function Profile({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  // The Groups card's Leave forms and the Notifications form post here too;
  // each button pends only for its own form's post.
  const submitting = useSubmitting();
  const intent = navigation.formData?.get("intent");
  const changingPassword = submitting && intent !== "leave" && intent !== NOTIFICATIONS_INTENT;
  const savingNotifications = submitting && intent === NOTIFICATIONS_INTENT;
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
            notifications, password, Groups, sessions, delete login. Name and
            colour and delete login come in later tickets. */}
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
      </main>
    </>
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
            const others = group.memberCount - 1;
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
                  {group.isOwner && others > 0 ? (
                    <span className="list-tile-detail">Make another Member Owner first</span>
                  ) : null}
                </span>
                {group.isOwner && others > 0 ? null : (
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
