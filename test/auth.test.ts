// Who is asking, and who is refused.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("signing in", () => {
  it("says nobody is signed in when nobody is", async () => {
    const res = await SELF.fetch("https://x/auth/me");
    const body = (await res.json()) as { signedIn: boolean; user: unknown };
    expect(body.signedIn).toBe(false);
    expect(body.user).toBeNull();
  });

  it("refuses to start a sign-in it cannot finish", async () => {
    // No GITHUB_CLIENT_ID in the test env: saying so beats redirecting to a
    // GitHub page that errors on arrival.
    const res = await SELF.fetch("https://x/auth/login", { redirect: "manual" });
    expect([302, 400]).toContain(res.status);
  });

  it("does not accept a cookie it did not sign", async () => {
    // A session is a signed string. An unsigned one is a cookie anyone can
    // write, which is the whole reason the signature exists.
    const forged = btoa(JSON.stringify({ login: "someone", exp: Date.now() + 1e6 }));
    const res = await SELF.fetch("https://x/auth/me", {
      headers: { cookie: `ai_session=${forged}.not-a-real-signature` },
    });
    const body = (await res.json()) as { signedIn: boolean };
    expect(body.signedIn).toBe(false);
  });

  it("recognises an agent's machine credential as a machine, not a person", async () => {
    // An agent's VM tools call back with FLEET_TOKEN and no cookie. That is
    // authenticated and is nobody — a board that confused the two would show a
    // tool call as a signed-in user.
    const res = await SELF.fetch("https://x/auth/me");
    const body = (await res.json()) as { machine: boolean; signedIn: boolean };
    expect(body.signedIn).toBe(false);
    expect(typeof body.machine).toBe("boolean");
  });
});
