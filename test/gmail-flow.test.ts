// End-to-end OAuth through the gateway and real account-scoped Durable Objects.
// Failure cases: unsigned state, lost account identity, leaked refresh token,
// another account seeing the connection, disconnected accounts retaining access.
// Write failures: recipient header injection, writes without compose consent,
// an agent sending directly, a browser send without a signed-in account/origin.
import { env, createExecutionContext } from "cloudflare:test";
import { it, expect, vi } from "vitest";
import worker from "../src/index.js";
import { issueSession } from "../src/auth.js";
import { storedKeys } from "../src/keys.js";
import type { Env } from "../src/types.js";

it("connects, searches and disconnects Gmail under the initiating account", async () => {
  const configured = { ...env, GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret", FLEET_TOKEN: "test-signing-key", GITHUB_APP_PRIVATE_KEY: undefined } as Env;
  const session = await issueSession(configured, { login: "gmail-flow-alice" });
  const cookie = `ai_session=${session}`;
  const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://example.com${path}`, init), configured, createExecutionContext());
  const start = await call("/gmail/connect", { headers: { cookie } });
  expect(start.status).toBe(302);
  const oauth = new URL(start.headers.get("location")!);
  expect(oauth.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/gmail.compose");
  const stateCookie = start.headers.get("set-cookie")!.split(";")[0];
  const rejected = await call("/gmail/callback?state=forged&code=test", { headers: { cookie: `${cookie}; ${stateCookie}` } });
  expect(rejected.status).toBe(400);
  const nativeFetch = globalThis.fetch;
  const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "test-access", refresh_token: "test-refresh", scope: oauth.searchParams.get("scope") });
    if (url.endsWith("/profile")) return Response.json({ emailAddress: "alice@example.com" });
    if (url.includes("/threads?")) return Response.json({ threads: [{ id: "abcdef" }] });
    if (url.endsWith("/drafts") && init?.method === "POST") return Response.json({ id: "draft-123", message: { id: "abcdef" } });
    if (url.endsWith("/revoke")) return new Response(null, { status: 200 });
    return nativeFetch(input, init);
  });
  try {
    const callback = await call(`/gmail/callback?state=${oauth.searchParams.get("state")}&code=test`, { headers: { cookie: `${cookie}; ${stateCookie}` } });
    expect(callback.status).toBe(302);
    const status = await call("/gmail/status", { headers: { cookie } });
    expect(await status.json()).toEqual({ configured: true, connected: true, email: "alice@example.com", writeEnabled: true });
    // Persistent artifact: the connection is in Alice's registry, absent in Bob's.
    expect((await storedKeys(configured, "gmail-flow-alice")).GMAIL_CONNECTION).toContain("alice@example.com");
    expect((await storedKeys(configured, "gmail-flow-bob")).GMAIL_CONNECTION).toBeUndefined();
    await call("/api/launch", { method: "POST", headers: { cookie }, body: JSON.stringify({ id: "gmail-flow-agent", harness: "claude-code", model: "claude-opus-4.8", capabilities: ["gmail_search", "gmail_draft"] }) });
    const search = await call("/agents/gmail-flow-agent/tool/gmail_search", { method: "POST", headers: { cookie }, body: JSON.stringify({ query: "designer" }) });
    const result = await search.text();
    expect(search.status).toBe(200);
    expect(result).toContain("abcdef");
    expect(result).not.toContain("test-refresh");
    const draft = await call("/agents/gmail-flow-agent/tool/gmail_draft", { method: "POST", headers: { cookie }, body: JSON.stringify({ to: "candidate@example.com", subject: "Interview", body: "Please share your availability." }) });
    expect(await draft.text()).toContain("draft-123");
    const injected = await call("/agents/gmail-flow-agent/tool/gmail_draft", { method: "POST", headers: { cookie }, body: JSON.stringify({ to: "candidate@example.com\r\nBcc: someone@example.com", subject: "Interview", body: "Hi" }) });
    expect(await injected.text()).toContain("valid recipient");
    const agentSend = await call("/agents/gmail-flow-agent/tool/gmail_send", { method: "POST", headers: { cookie }, body: JSON.stringify({ id: "draft-123" }) });
    expect(agentSend.status).toBe(400);
    const noOrigin = await call("/gmail/send", { method: "POST", headers: { cookie }, body: JSON.stringify({ id: "draft-123" }) });
    expect(noOrigin.status).toBe(403);
    const signedOutSend = await call("/gmail/send", { method: "POST", headers: { origin: "https://example.com" }, body: JSON.stringify({ id: "draft-123" }) });
    expect(signedOutSend.status).toBe(401);
    const disconnected = await call("/gmail/disconnect", { method: "POST", headers: { cookie, origin: "https://example.com" } });
    expect(disconnected.status).toBe(200);
    expect((await storedKeys(configured, "gmail-flow-alice")).GMAIL_CONNECTION).toBeUndefined();
  } finally { mock.mockRestore(); }
});
