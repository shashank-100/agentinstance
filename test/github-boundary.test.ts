import { describe, it, expect } from "vitest";
import { tokenForRepo } from "../src/github-app.js";

describe("reaching a repository", () => {
  it("refuses an owner whose installation does not cover it", async () => {
    // The boundary. Without the owner argument an installation *is* the
    // permission: any repo the app was ever installed on answers to anyone.
    const out = await tokenForRepo(
      { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "not-a-key" },
      "someone-else/private",
      "alice",
    );
    expect(out.token).toBeUndefined();
    expect(out.error).toBeTruthy();
  });

  it("leaves an unowned agent alone", async () => {
    // Everything predating sign-in passes no owner and must keep working.
    const out = await tokenForRepo({ GITHUB_TOKEN: "ghp_x" }, "owner/repo");
    expect(out.token).toBe("ghp_x");
  });
});
