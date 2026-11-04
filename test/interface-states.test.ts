import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Notice } from "~/components/notice";
import { OfflineStatus } from "~/components/offline-bar";
import { isSubmittingTo, SubmitButton } from "~/components/submit-button";
import { TAP_AGAIN_MS, tapAgain, TapAgainButton } from "~/components/tap-again-button";

import { startApp } from "./harness";

const OFFLINE_COPY = "Offline. Answers won&#x27;t save until you&#x27;re back online.";

function bodyOf(html: string): string {
  return html.slice(html.indexOf("<body"), html.indexOf("</body>"));
}

/** The opening tag of the element with this id. */
function tagWithId(html: string, id: string): string {
  const match = html.match(new RegExp(`<[a-z]+\\s[^>]*id="${id}"[^>]*>`));
  expect(match, `element #${id}`).not.toBeNull();
  return match![0];
}

/** The text of the element with this id, with React's text-node markers dropped. */
function textOfId(html: string, id: string): string {
  const match = html.match(new RegExp(`<([a-z]+)\\s[^>]*id="${id}"[^>]*>([\\s\\S]*?)</\\1>`));
  expect(match, `element #${id}`).not.toBeNull();
  return match![2].replaceAll("<!-- -->", "");
}

/** The opening tag of the submit button whose text is `label`. */
function submitButton(html: string, label: string): string {
  const match = html.match(new RegExp(`(<button[^>]*type="submit"[^>]*>)${label}</button>`));
  expect(match, `${label} button`).not.toBeNull();
  return match![1];
}

const alice = { username: "Alice", password: "correct horse battery", colour: "violet" };

describe("field errors", () => {
  it("marks a too-short username invalid and points it at an Error: line", async () => {
    const app = startApp();
    const token = await app.issueSetupLink();
    const response = await (await app.deviceWithLink(`/setup/${token}`)).post("/setup", { ...alice, username: "Al" });
    const html = bodyOf(await response.text());

    expect(response.status).toBe(400);
    const input = tagWithId(html, "username");
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('aria-describedby="username-help"');
    expect(tagWithId(html, "username-help")).toContain('class="field-error"');
    expect(textOfId(html, "username-help")).toBe("Error: Use 3 to 32 characters.");
    // The other fields stay valid and keep their hints.
    expect(tagWithId(html, "password")).not.toContain("aria-invalid");
    expect(textOfId(html, "password-help")).not.toMatch(/^Error: /);
  });

  it("marks a too-short password invalid and points it at an Error: line", async () => {
    const app = startApp();
    const token = await app.issueSetupLink();
    const response = await (await app.deviceWithLink(`/setup/${token}`)).post("/setup", { ...alice, password: "short" });
    const html = bodyOf(await response.text());

    expect(response.status).toBe(400);
    expect(tagWithId(html, "password")).toContain('aria-invalid="true"');
    expect(textOfId(html, "password-help")).toBe("Error: Use 12 to 128 characters.");
  });

  it("points the colour picker at an Error: line when no colour is chosen", async () => {
    const app = startApp();
    const token = await app.issueSetupLink();
    const response = await (await app.deviceWithLink(`/setup/${token}`)).post("/setup", { username: "Alice", password: alice.password });
    const html = bodyOf(await response.text());

    expect(response.status).toBe(400);
    const fieldset = html.match(/<fieldset[^>]*>/)![0];
    expect(fieldset).toContain('role="radiogroup"');
    expect(fieldset).toContain('aria-invalid="true"');
    expect(fieldset).toContain('aria-describedby="colour-error"');
    expect(tagWithId(html, "colour-error")).toContain('class="field-error"');
    expect(textOfId(html, "colour-error")).toBe("Error: Choose a colour.");
  });

  it("shows no Error: line on a fresh form", async () => {
    const app = startApp();
    const token = await app.issueSetupLink();
    const html = bodyOf(await (await app.device().open(`/setup/${token}`)).text());

    expect(html).not.toContain("Error: ");
    expect(html).not.toContain("aria-invalid");
    const fieldset = html.match(/<fieldset[^>]*>/)![0];
    expect(fieldset).toContain('role="radiogroup"');
    expect(fieldset).not.toContain("aria-describedby");
  });
});

describe("form errors", () => {
  it("shows a failed login as an alert notice with its title and message", async () => {
    const response = await startApp().device().post("/login", { username: "nobody", password: "wrong password!" });
    const html = bodyOf(await response.text());

    expect(response.status).toBe(401);
    expect(html).toMatch(
      /<div class="notice-error" role="alert"><p class="notice-title">Can&#x27;t log in<\/p><p>That username and password do not match.<\/p><\/div>/,
    );
    // A login failure is form-wide: no field is marked.
    expect(html).not.toContain("aria-invalid");
  });
});

describe("idle forms", () => {
  async function pages() {
    const app = startApp();
    const token = await app.issueSetupLink();
    const browser = await app.createLogin({ username: "Alice", password: alice.password });
    return {
      login: await (await app.fetch("/login")).text(),
      setup: await (await app.device().open(`/setup/${token}`)).text(),
      unusable: await (await app.device().open("/setup/not-a-real-token")).text(),
      tonight: await (await browser.get("/")).text(),
      profile: await (await browser.get("/profile")).text(),
    };
  }

  it("renders every submit button idle, with its label and no busy state", async () => {
    const { login, setup, profile } = await pages();

    for (const [html, label] of [
      [login, "Log in"],
      [setup, "Create login"],
      [profile, "Save"],
      [profile, "Log out"],
      [profile, "Log out everywhere"],
    ]) {
      const button = submitButton(html, label);
      expect(button, label).not.toContain("aria-busy");
      expect(button, label).not.toContain("aria-disabled");
    }
    expect(submitButton(profile, "Save")).toContain('class="btn-primary"');
    expect(submitButton(profile, "Log out")).toContain('class="btn-secondary"');
    expect(submitButton(profile, "Log out everywhere")).toContain('class="btn-destructive"');
    for (const html of [login, setup, profile]) expect(html).not.toContain("btn-ring");
  });

  it("renders no Offline bar on the server, and no inline styles", async () => {
    for (const [name, html] of Object.entries(await pages())) {
      expect(html, name).not.toContain("Offline");
      expect(html, name).not.toMatch(/\sstyle=/);
      // The empty live region is there, so the bar is announced when it appears.
      expect(bodyOf(html), name).toContain('<div class="offline-status" role="status"></div>');
    }
  });
});

describe("isSubmittingTo", () => {
  it("is false while idle", () => {
    expect(isSubmittingTo({ state: "idle" }, "/logout")).toBe(false);
  });

  it("is true while submitting to this action", () => {
    expect(isSubmittingTo({ state: "submitting", formAction: "/logout" }, "/logout")).toBe(true);
  });

  it("stays true while loading the redirect that follows this action", () => {
    expect(isSubmittingTo({ state: "loading", formAction: "/logout" }, "/logout")).toBe(true);
  });

  it("is false while submitting to another action", () => {
    expect(isSubmittingTo({ state: "submitting", formAction: "/logout-everywhere" }, "/logout")).toBe(false);
  });
});

describe("SubmitButton", () => {
  const props = { label: "Log in", pendingLabel: "Logging in…", className: "btn-primary" };

  it("shows its label when idle", () => {
    const html = renderToString(createElement(SubmitButton, { ...props, pending: false }));

    expect(html).toBe('<button type="submit" class="btn-primary">Log in</button>');
  });

  it("shows the ring and the …ing label while pending, busy and disabled for taps", () => {
    const html = renderToString(createElement(SubmitButton, { ...props, pending: true }));

    expect(html).toMatch(/^<button type="submit" class="btn-primary"[^>]*>/);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-disabled="true"');
    // Pending is not disabled: the button keeps focus and its fill.
    expect(html).not.toMatch(/\sdisabled=/);
    expect(html).toContain('<span class="btn-ring" aria-hidden="true"></span>');
    expect(html).toContain("Logging in…");
    expect(html).not.toContain(">Log in<");
  });
});

describe("tapAgain", () => {
  const armedAt = 1_000_000;

  it("arms a button that is not armed", () => {
    expect(tapAgain(null, armedAt)).toBe("arm");
  });

  it("confirms a second tap inside the wait", () => {
    expect(tapAgain(armedAt, armedAt + TAP_AGAIN_MS - 1)).toBe("confirm");
  });

  it("arms again once the wait is over", () => {
    expect(TAP_AGAIN_MS).toBe(4000);
    expect(tapAgain(armedAt, armedAt + TAP_AGAIN_MS)).toBe("arm");
  });
});

describe("TapAgainButton", () => {
  const props = {
    label: "Log out everywhere",
    confirmLabel: "Tap again to log out every device",
    pendingLabel: "Logging out…",
    pending: false,
  };

  it("is a plain destructive submit button when idle", () => {
    const html = renderToString(createElement(TapAgainButton, props));

    expect(html).toBe('<button type="submit" class="btn-destructive">Log out everywhere</button>');
  });

  it("shows the confirm label and carries the confirmation when armed", () => {
    const html = renderToString(createElement(TapAgainButton, { ...props, armed: true }));

    expect(html).toBe(
      '<button data-armed="true" type="submit" class="btn-destructive">Tap again to log out every device</button>' +
        '<input type="hidden" name="confirm" value="yes"/>',
    );
  });

  it("shows the ring while the confirmed submit is pending", () => {
    const html = renderToString(createElement(TapAgainButton, { ...props, armed: true, pending: true }));

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('<span class="btn-ring" aria-hidden="true"></span>');
    expect(html).toContain("Logging out…");
  });
});

describe("Notice", () => {
  it("renders an error as an alert with a title and a body", () => {
    const html = renderToString(createElement(Notice, { tone: "error", title: "Can't save", children: "Try once more." }));

    expect(html).toBe(
      '<div class="notice-error" role="alert"><p class="notice-title">Can&#x27;t save</p><p>Try once more.</p></div>',
    );
  });

  it("adds a Try again button when it can retry", () => {
    const retry = () => {};
    const html = renderToString(
      createElement(Notice, { tone: "error", title: "Can't save", retry, children: "Your answer did not save." }),
    );

    expect(html).toContain('<button type="button" class="btn-secondary">Try again</button>');
  });

  it("is not an alert for information or a warning", () => {
    for (const tone of ["info", "warning"] as const) {
      const html = renderToString(createElement(Notice, { tone, title: "Heads up", children: "Body." }));
      expect(html).toMatch(new RegExp(`^<div class="notice-${tone}">`));
      expect(html).not.toContain("role=");
      expect(html).not.toContain("Try again");
    }
  });
});

describe("OfflineStatus", () => {
  it("is an empty live region while online", () => {
    expect(renderToString(createElement(OfflineStatus, { offline: false }))).toBe(
      '<div class="offline-status" role="status"></div>',
    );
  });

  it("shows the Offline bar while offline", () => {
    expect(renderToString(createElement(OfflineStatus, { offline: true }))).toBe(
      `<div class="offline-status" role="status"><p class="offline-bar">${OFFLINE_COPY}</p></div>`,
    );
  });
});
