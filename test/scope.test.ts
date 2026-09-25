// Two people, the same agent name, two different objects.
import { describe, it, expect } from "vitest";
import { DEPLOYMENT, fleetName, registryName, scoped, unscope } from "../src/scope.js";

describe("addressing", () => {
  it("gives two owners different objects for the same name", () => {
    // The whole point. If these matched, both people would be talking to one
    // Durable Object — one memory, one container, one conversation.
    expect(scoped("alice", "reviewer")).not.toBe(scoped("bob", "reviewer"));
  });

  it("leaves an unowned deployment addressing exactly what it always did", () => {
    // An existing deployment's agents are addressed unscoped. Changing that
    // would point it at empty objects and lose everything already running.
    expect(scoped(DEPLOYMENT, "reviewer")).toBe("reviewer");
    expect(fleetName(DEPLOYMENT)).toBe("global");
    expect(registryName(DEPLOYMENT)).toBe("global");
  });

  it("refuses a name that would address someone else's object", () => {
    // An agent id arrives from a URL. Accepting a separator in it would make
    // `alice/reviewer` typeable by anyone.
    expect(() => scoped("bob", "alice/reviewer")).toThrow();
  });

  it("reads an owner back out, so an agent can find its own board", () => {
    // An agent knows its full name and nothing else; this is how fleet_task
    // reaches the right queue instead of a shared one.
    expect(unscope("alice/reviewer")).toEqual({ owner: "alice", name: "reviewer" });
    expect(unscope("reviewer")).toEqual({ owner: DEPLOYMENT, name: "reviewer" });
  });

  it("keeps each owner's board and agent list separate", () => {
    expect(fleetName("alice")).not.toBe(fleetName("bob"));
    expect(registryName("alice")).not.toBe(registryName("bob"));
  });
});
