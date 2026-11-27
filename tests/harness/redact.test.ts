import { describe, expect, test } from "vitest";
import { redactLoginUrls } from "./dsh.ts";

// A made-up token in the shape dsh prints; no real login URL appears in this repository.
const TOKEN = "AbC123-xyz_789";

describe("redactLoginUrls", () => {
  test("replaces the login URL dsh prints", () => {
    const text = `dsh web: http://127.0.0.1:41234/?token=${TOKEN}\n`;
    const redacted = redactLoginUrls(text);
    expect(redacted).toBe("dsh web: <url>\n");
    expect(redacted).not.toContain(TOKEN);
  });

  test("replaces every URL, https and paths included", () => {
    const text =
      `open https://localhost:8092/chat?x=1&token=${TOKEN} or ` +
      `http://[::1]:9000/a/b#token=${TOKEN} now`;
    expect(redactLoginUrls(text)).toBe("open <url> or <url> now");
  });

  test("catches a token outside a URL", () => {
    const redacted = redactLoginUrls(`query: ?token=${TOKEN}&next=1`);
    expect(redacted).not.toContain(TOKEN);
    expect(redacted).toBe("query: ?token=<redacted>&next=1");
  });

  test("leaves text without URLs alone", () => {
    const text = "dsh: warning: 1 entry did not activate\n    at apply (/tmp/x.ts:3:9)";
    expect(redactLoginUrls(text)).toBe(text);
  });
});
