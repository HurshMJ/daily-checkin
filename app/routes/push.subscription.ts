import { hashToken } from "~/auth/crypto";
import { currentSession, requireMember } from "~/auth/request";
import { createPush, validateSubscription } from "~/push";
import { appContext } from "~/services";

import type { Route } from "./+types/push.subscription";

function status(code: number): Response {
  return new Response(null, { status: code, headers: { "Cache-Control": "no-store" } });
}

/**
 * The device's push subscription, posted by the profile's Notifications card
 * as form fields. Intent "save" stores a valid subscription for this session;
 * "delete" removes the endpoint if it is the Member's own. A logged-out post
 * is sent to /login like every other route, and the Worker's Origin check has
 * already refused a cross-origin one.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const member = requireMember(context);
  const form = await request.formData();
  const push = createPush(context.get(appContext));
  const intent = form.get("intent");

  if (intent === "delete") {
    const endpoint = form.get("endpoint");
    if (typeof endpoint !== "string" || endpoint === "") return status(400);
    await push.deleteSubscription(member.id, endpoint);
    return status(204);
  }
  if (intent !== "save") return status(400);

  const subscription = validateSubscription({
    endpoint: form.get("endpoint"),
    p256dh: form.get("p256dh"),
    auth: form.get("auth"),
  });
  if (!subscription) return status(400);
  // requireMember passed, so the session is there.
  const token = currentSession(context)!.token;
  await push.saveSubscription(member.id, await hashToken(token), subscription);
  return status(204);
}
