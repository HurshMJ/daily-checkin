import { useEffect, useState } from "react";
import { Form } from "react-router";

import { decodeBase64Url, NOTIFICATION_TYPES, type NotificationPrefs } from "~/push";

import { Notice } from "./notice";
import { SubmitButton } from "./submit-button";

/** The profile form's intent for saving the toggles. */
export const NOTIFICATIONS_INTENT = "notifications";

/** Each toggle's name and the line that says when it fires. */
const TOGGLES: Record<keyof NotificationPrefs, { name: string; detail: string }> = {
  said_yes: { name: "Someone said Yes", detail: "When someone answers Yes in one of your Groups." },
  game_on: { name: "Game On", detail: "When one of your Groups reaches its threshold." },
  game_off: { name: "Game Off", detail: "When a Group you said Yes in drops below it." },
  reminder: { name: "Reminder", detail: "At 5 PM if one of your Groups has no answer from you tonight." },
  daily_summary: { name: "Daily Summary", detail: "At 8 PM, each of your Groups' answers for tonight." },
};

/** Reads the posted toggles: a checked box sends "on", an unchecked one sends nothing. */
export function togglesFrom(form: FormData): NotificationPrefs {
  return Object.fromEntries(NOTIFICATION_TYPES.map((type) => [type, form.get(type) === "on"])) as NotificationPrefs;
}

/**
 * Where push stands on this device. The server renders "no-js"; once the
 * page's JavaScript runs it finds the real state.
 */
type PushState = "no-js" | "unconfigured" | "unsupported" | "install" | "blocked" | "off" | "on" | "working" | "failed";

const SUBSCRIPTION_PATH = "/push/subscription";

/** iPhone and iPad, including an iPad that reports itself as a Mac. */
function isAppleMobile(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

/** Opened from the home screen rather than in the browser. */
function isStandalone(): boolean {
  return matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

async function postSubscription(fields: Record<string, string>): Promise<boolean> {
  const response = await fetch(SUBSCRIPTION_PATH, { method: "POST", body: new URLSearchParams(fields) });
  return response.status === 204;
}

function sameKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((byte, index) => byte === key[index]);
}

/**
 * Turns push on: asks for permission on the tap, registers the service
 * worker, subscribes with the server's public key and sends the subscription
 * to the server. A subscription made with an older key is replaced.
 */
async function turnOn(publicKey: string): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "blocked" : "off";
  const key = decodeBase64Url(publicKey);
  if (!key) return "unconfigured";
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key as Uint8Array<ArrayBuffer>,
  });
  const { endpoint, keys } = subscription.toJSON();
  if (!endpoint || !keys?.p256dh || !keys.auth) return "failed";
  const saved = await postSubscription({ intent: "save", endpoint, p256dh: keys.p256dh, auth: keys.auth });
  return saved ? "on" : "failed";
}

/** Turns push off on this device: the server forgets the endpoint, then the browser drops it. */
async function turnOff(): Promise<PushState> {
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    if (!(await postSubscription({ intent: "delete", endpoint: subscription.endpoint }))) return "failed";
    await subscription.unsubscribe();
  }
  return "off";
}

/** What this device's push state is, read once the page's JavaScript runs. */
async function currentState(publicKey: string, onHere: boolean): Promise<PushState> {
  if (!publicKey) return "unconfigured";
  // iPhone Safari has no push outside the installed app, so check that first.
  if (isAppleMobile() && !isStandalone()) return "install";
  if (!("serviceWorker" in navigator && "PushManager" in window && "Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  if (!onHere) return "off";
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ? "on" : "off";
}

/**
 * Push on this device. Permission is only ever asked from a tap on Turn on
 * push, never on page load. Every state is said in words.
 */
function PushControl({ publicKey, onHere }: { publicKey: string; onHere: boolean }) {
  const [state, setState] = useState<PushState>("no-js");

  useEffect(() => {
    currentState(publicKey, onHere).then(setState, () => setState("unsupported"));
  }, [publicKey, onHere]);

  function act(action: () => Promise<PushState>) {
    setState("working");
    action().then(setState, () => setState("failed"));
  }

  switch (state) {
    case "no-js":
      return <p className="card-hint">Turning on push on this device needs JavaScript.</p>;
    case "unconfigured":
      return <p className="card-hint">Push is not set up on this server yet.</p>;
    case "unsupported":
      return <p className="card-hint">This browser cannot get push notifications.</p>;
    case "install":
      return (
        <Notice tone="warning" title="Add to Home Screen first">
          On iPhone, push works only in the installed app. Tap Share, then Add to Home Screen, and turn push on from
          there.
        </Notice>
      );
    case "blocked":
      return (
        <Notice tone="warning" title="Notifications are blocked">
          Allow notifications for this site in your browser settings, then come back here.
        </Notice>
      );
    case "on":
      return (
        <div className="card-action">
          <button type="button" className="btn-secondary" onClick={() => act(turnOff)}>
            Turn off on this device
          </button>
          <p className="card-hint">Push is on for this device.</p>
        </div>
      );
    case "working":
      return (
        <div className="card-action">
          <SubmitButton pending label="Turn on push" pendingLabel="Working…" className="btn-primary" />
        </div>
      );
    default:
      return (
        <div className="card-action">
          <button type="button" className="btn-primary" onClick={() => act(() => turnOn(publicKey))}>
            Turn on push
          </button>
          <p className="card-hint" role={state === "failed" ? "alert" : undefined}>
            {state === "failed" ? "Push could not be turned on. Try again." : "Push is off for this device."}
          </p>
        </div>
      );
  }
}

/**
 * The profile's Notifications card: push on this device, then one switch per
 * event type in a plain form that works without JavaScript. Each switch says
 * On or Off in words.
 */
export function NotificationsCard({
  publicKey,
  onHere,
  prefs,
  saved,
  saving,
}: {
  publicKey: string;
  onHere: boolean;
  prefs: NotificationPrefs;
  saved: boolean;
  saving: boolean;
}) {
  return (
    <section className="card" aria-labelledby="notifications-heading">
      <h2 id="notifications-heading">Notifications</h2>
      <PushControl publicKey={publicKey} onHere={onHere} />
      <Form method="post" className="page-form">
        <input type="hidden" name="intent" value={NOTIFICATIONS_INTENT} />
        <ul className="list">
          {NOTIFICATION_TYPES.map((type) => (
            <li key={type}>
              <label className="toggle">
                <span className="toggle-text">
                  <span className="toggle-name" id={`toggle-${type}-name`}>
                    {TOGGLES[type].name}
                  </span>
                  <span className="toggle-detail" id={`toggle-${type}-detail`}>
                    {TOGGLES[type].detail}
                  </span>
                </span>
                <input
                  className="toggle-input"
                  type="checkbox"
                  role="switch"
                  name={type}
                  defaultChecked={prefs[type]}
                  aria-labelledby={`toggle-${type}-name`}
                  aria-describedby={`toggle-${type}-detail`}
                />
                <span className="toggle-switch" aria-hidden="true">
                  <span className="toggle-on">On</span>
                  <span className="toggle-off">Off</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div role="status">{saved ? <p className="card-hint">Notification settings saved.</p> : null}</div>
        <SubmitButton pending={saving} label="Save notifications" pendingLabel="Saving…" className="btn-secondary" />
      </Form>
    </section>
  );
}
