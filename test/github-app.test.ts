import { describe, it, expect } from "vitest";
import { hasGitHubCredentials, tokenForRepo } from "../src/github-app.js";

// A throwaway PKCS#8 RSA key, generated for this test and used nowhere else.
// Signing has to run against a real key: the JWT path is the part most likely
// to break silently, and a mocked signer would prove nothing about it.
const TEST_KEY = await (async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
})();

describe("which credential a deployment uses", () => {
  it("offers nothing when neither is configured", () => {
    expect(hasGitHubCredentials({})).toBe(false);
  });

  it("accepts a personal access token on its own", () => {
    expect(hasGitHubCredentials({ GITHUB_TOKEN: "ghp_x" })).toBe(true);
  });

  it("does not accept half an app", () => {
    // An id without a key cannot sign, so offering the capability would
    // promise something that fails at the first push.
    expect(hasGitHubCredentials({ GITHUB_APP_ID: "1" })).toBe(false);
    expect(hasGitHubCredentials({ GITHUB_APP_PRIVATE_KEY: TEST_KEY })).toBe(false);
  });

  it("accepts a whole app", () => {
    expect(
      hasGitHubCredentials({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: TEST_KEY }),
    ).toBe(true);
  });
});

describe("resolving a token for a repository", () => {
  it("explains itself when nothing is configured", async () => {
    const got = await tokenForRepo({}, "owner/name");
    expect(got.token).toBeUndefined();
    // The message has to name what to set: this surfaces to an agent, which
    // cannot read the source to find out.
    expect(got.error).toMatch(/GITHUB_APP_ID|GITHUB_TOKEN/);
  });

  it("falls back to a personal access token", async () => {
    const got = await tokenForRepo({ GITHUB_TOKEN: "ghp_x" }, "owner/name");
    expect(got.token).toBe("ghp_x");
  });

  it("rejects a PKCS#1 key by name rather than failing at import", async () => {
    // GitHub hands out PKCS#1; WebCrypto reads only PKCS#8. Saying so is the
    // difference between a one-line fix and debugging an auth failure.
    const got = await tokenForRepo(
      {
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
      },
      "owner/name",
    );
    expect(got.error).toMatch(/PKCS#1|pkcs8/);
  });

  it("prefers the app when both are configured", async () => {
    // The app is reached first, so the PAT is not returned: this call fails at
    // the network (no such installation) rather than silently handing back
    // `ghp_x`, which would mean the app was never consulted.
    const got = await tokenForRepo(
      { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: TEST_KEY, GITHUB_TOKEN: "ghp_x" },
      "owner/name",
    );
    expect(got.token).not.toBe("ghp_x");
  });
});
