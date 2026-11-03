import type { ButtonHTMLAttributes } from "react";
import { useFormAction, useNavigation } from "react-router";

/**
 * True while a navigation submits to `formAction`, through the redirect that
 * follows it (React Router keeps formAction set while it loads the target).
 */
export function isSubmittingTo(navigation: { state: string; formAction?: string }, formAction: string): boolean {
  return navigation.state !== "idle" && navigation.formAction === formAction;
}

/**
 * True while a submission to this form's action is in flight, through the
 * redirect that follows it. Pass the Form's `action`, or nothing for a form
 * that posts to its own route, so two forms on one page never both pend.
 */
export function useSubmitting(action?: string): boolean {
  return isSubmittingTo(useNavigation(), useFormAction(action));
}

/**
 * A form's submit button. While pending it shows a ring and its "…ing"
 * label, reports itself busy, and ignores further taps. It never uses the
 * disabled attribute, which would drop focus and grey out the fill. Other
 * button attributes, such as a click handler or a data attribute, pass
 * through to the one <button>.
 */
export function SubmitButton({
  pending,
  label,
  pendingLabel,
  className,
  ...button
}: {
  pending: boolean;
  label: string;
  pendingLabel: string;
  className: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "className" | "children">) {
  if (!pending) {
    return (
      <button {...button} type="submit" className={className}>
        {label}
      </button>
    );
  }
  return (
    <button
      {...button}
      type="submit"
      className={className}
      aria-busy="true"
      aria-disabled="true"
      onClick={(event) => event.preventDefault()}
    >
      <span className="btn-ring" aria-hidden="true" />
      {pendingLabel}
    </button>
  );
}
