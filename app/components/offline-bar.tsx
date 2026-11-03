import { useSyncExternalStore } from "react";

export const OFFLINE_MESSAGE = "Offline. Answers won't save until you're back online.";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

const browserIsOnline = () => navigator.onLine;
// The server cannot know, so it renders the online state; so does the first
// client render, which keeps hydration in step.
const serverIsOnline = () => true;

/**
 * The live region the Offline bar appears in. It is always rendered, empty
 * while online, so screen readers announce the bar when it appears.
 */
export function OfflineStatus({ offline }: { offline: boolean }) {
  return (
    <div className="offline-status" role="status">
      {offline ? <p className="offline-bar">{OFFLINE_MESSAGE}</p> : null}
    </div>
  );
}

/** The Offline bar, shown while the browser reports no connection. */
export function OfflineBar() {
  const online = useSyncExternalStore(subscribe, browserIsOnline, serverIsOnline);
  return <OfflineStatus offline={!online} />;
}
