import { createRequestHandler, RouterContextProvider } from "react-router";

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
      const context = new RouterContextProvider(
        new Map([[appContext, { ...services, env, ctx }]]),
      );
      return requestHandler(request, context);
    },

    async scheduled(_controller, _env, _ctx) {
      // The hourly run has no jobs yet. Later jobs receive `services` and `env`
      // from here, the same way requests do.
    },
  } satisfies ExportedHandler<Env>;
}

export default createWorker(productionServices);
