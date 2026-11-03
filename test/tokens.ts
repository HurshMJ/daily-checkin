import tokensCss from "~/styles/tokens.css?raw";

/** Reads every custom property in a stylesheet as name and raw value. */
export function customProperties(css: string): Map<string, string> {
  const props = new Map<string, string>();
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    props.set(match[1], match[2].trim());
  }
  return props;
}

/** The design tokens in app/styles/tokens.css, the one owner of every colour. */
export const tokens = customProperties(tokensCss);
