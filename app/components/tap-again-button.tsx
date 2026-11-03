import { useEffect, useState, type MouseEvent } from "react";

import { SubmitButton } from "./submit-button";

/** How long an armed button waits for the second tap before it reverts. */
export const TAP_AGAIN_MS = 4000;

/**
 * The form field an armed button submits, and its one accepted value. An
 * action that sits behind a TapAgainButton acts only when the posted form
 * has it, so a first tap without JavaScript changes nothing.
 */
export const CONFIRM_FIELD = "confirm";
const CONFIRM_VALUE = "yes";

/** True when a posted form carries the armed button's confirmation. */
export function isConfirmed(form: FormData): boolean {
  return form.get(CONFIRM_FIELD) === CONFIRM_VALUE;
}

/**
 * What a tap does: confirm when the button was armed less than TAP_AGAIN_MS
 * ago, otherwise arm it.
 */
export function tapAgain(armedAt: number | null, now: number): "arm" | "confirm" {
  return armedAt !== null && now - armedAt < TAP_AGAIN_MS ? "confirm" : "arm";
}

/**
 * A destructive submit button that needs two taps. The first tap arms it:
 * solid No fill and confirmLabel. A second tap within TAP_AGAIN_MS submits;
 * otherwise it reverts. Armed, it adds the confirmation field to its form.
 * Pass `armed` when the server sends the page back after a first tap made
 * without JavaScript, so the next tap confirms. It stays one <button>
 * throughout, so it keeps focus.
 */
export function TapAgainButton({
  label,
  confirmLabel,
  pendingLabel,
  pending,
  armed: serverArmed = false,
}: {
  label: string;
  confirmLabel: string;
  pendingLabel: string;
  pending: boolean;
  armed?: boolean;
}) {
  const [armedAt, setArmedAt] = useState<number | null>(() => (serverArmed ? Date.now() : null));
  const armed = armedAt !== null;

  // A server-armed button counts its wait from when it reaches the page.
  useEffect(() => {
    if (serverArmed) setArmedAt(Date.now());
  }, [serverArmed]);

  // Revert once the wait is over. A new arm or unmount clears the old timer.
  useEffect(() => {
    if (armedAt === null) return;
    const timer = setTimeout(() => setArmedAt(null), TAP_AGAIN_MS);
    return () => clearTimeout(timer);
  }, [armedAt]);

  function onClick(event: MouseEvent<HTMLButtonElement>) {
    const now = Date.now();
    if (tapAgain(armedAt, now) === "arm") {
      event.preventDefault();
      setArmedAt(now);
    }
  }

  return (
    <>
      <SubmitButton
        pending={pending}
        label={armed ? confirmLabel : label}
        pendingLabel={pendingLabel}
        className="btn-destructive"
        data-armed={armed ? "true" : undefined}
        onClick={onClick}
      />
      {armed ? <input type="hidden" name={CONFIRM_FIELD} value={CONFIRM_VALUE} /> : null}
    </>
  );
}
