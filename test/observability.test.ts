import { describe, expect, it } from "vitest";

import wranglerJsonc from "../wrangler.jsonc?raw";

/** wrangler.jsonc as an object: comments and trailing commas removed, as wrangler allows them. */
function wranglerConfig() {
  const json = wranglerJsonc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(json);
}

describe("Workers observability", () => {
  it("keeps app console logs but turns off invocation logs, which record link tokens in request URLs", () => {
    const { observability } = wranglerConfig();

    expect(observability.enabled).toBe(true);
    expect(observability.logs?.invocation_logs).toBe(false);
  });
});
