import { appContext } from "~/services";

import type { Route } from "./+types/healthz";

/**
 * Liveness check for the Operator and the deploy pipeline: proves the Worker
 * answers, D1 is reachable with migrations applied, and reports the clock's
 * idea of now.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { env, clock } = context.get(appContext);
  await env.DB.prepare("SELECT last_reset_game_night FROM scheduler_state LIMIT 1").all();
  return Response.json(
    { ok: true, now: clock.now().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
