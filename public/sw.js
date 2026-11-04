// Daily Check-in service worker: shows push notifications and opens the app
// when one is tapped. It caches nothing. Registered at scope "/" by the
// profile's Turn on push button.

// Every push shows a notification. Browsers, iPhone Safari above all, revoke
// push for a site that receives a push and shows nothing.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Daily Check-in";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      icon: "/icon-192.png",
      data: { url: typeof data.url === "string" ? data.url : "/" },
    }),
  );
});

// A tap focuses an open window of the app on the payload's page, or opens
// one. Only pages of this app are ever opened. A window this worker does not
// control cannot be navigated (navigate rejects or gives null), so the page
// opens in a new window instead.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let url = new URL("/", self.location.origin);
  try {
    const target = new URL(event.notification.data?.url ?? "/", self.location.origin);
    if (target.origin === self.location.origin) url = target;
  } catch {
    // Keep "/".
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const same = windows.find((client) => client.url === url.href);
      if (same) return same.focus();
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        const navigated = await open.navigate(url.href).catch(() => null);
        if (navigated) return navigated;
      }
      return self.clients.openWindow(url.href);
    })(),
  );
});
