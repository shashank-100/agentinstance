import { describe, it, expect } from "vitest";
import { whoIs } from "../src/auth.js";

// Failure #7 from the list: VM tools carry FLEET_TOKEN as a bearer and have no
// cookie. If the guard stopped accepting that, every running agent's callbacks
// would fail — the one regression here that breaks production rather than a UI.
describe("the machine credential", () => {
  const env = { FLEET_TOKEN: "secret-token" } as never;

  it("is accepted as a bearer header", async () => {
    const who = await whoIs(
      new Request("https://x/api/fleet/tasks", {
        headers: { authorization: "Bearer secret-token" },
      }),
      env,
    );
    expect(who.machine).toBe(true);
  });

  it("is accepted on the query string, as the python tools send it", async () => {
    const who = await whoIs(new Request("https://x/api/fleet/tasks?token=secret-token"), env);
    expect(who.machine).toBe(true);
  });

  it("is not granted to a wrong token", async () => {
    const who = await whoIs(
      new Request("https://x/", { headers: { authorization: "Bearer nope" } }),
      env,
    );
    expect(who.machine).toBe(false);
    expect(who.user).toBeNull();
  });

  it("is not granted to no credential at all", async () => {
    const who = await whoIs(new Request("https://x/"), env);
    expect(who.machine).toBe(false);
    expect(who.user).toBeNull();
  });
});
