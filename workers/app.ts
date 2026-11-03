import { createRequestHandler, RouterContextProvider } from "react-router";

import { refuseCrossOrigin } from "../app/auth/request";
import { createHistory } from "../app/history";
import { appContext, productionServices, type Services } from "../app/services";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

/**
 * Builds the Worker's entry points around one set of services. The default
 * export uses the production services; tests call `createWorker()` with a
 * fixed clock and a recording push sender and then invoke the same `fetch`
 * and `scheduled` handlers the runtime calls.
 */
export function createWorker(services: Services) {
  return {
    async fetch(request, env, ctx) {
      const refused = refuseCrossOrigin(request);
      if (refused) return refused;
      const context = new RouterContextProvider(
        new Map([[appContext, { ...services, env, ctx }]]),
      );
      return requestHandler(request, context);
    },

    // The hourly run. Each job receives `services` and `env`, the same way
    // requests do, and decides for itself whether it is due.
    async scheduled(_controller, env, _ctx) {
      await createHistory({ ...services, env }).reset();
    },
  } satisfies ExportedHandler<Env>;
}

export default createWorker(productionServices);
