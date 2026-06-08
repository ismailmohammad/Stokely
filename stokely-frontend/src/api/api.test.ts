import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

describe("api request wrapper", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.cookie = "stokely-csrf=test-csrf-token; path=/";
  });

  it("attaches CSRF header on mutating requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => "",
    } as Response);

    await api.auth.logout();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    expect(options?.credentials).toBe("include");
    expect((options?.headers as Record<string, string>)["X-CSRF-Token"]).toBe("test-csrf-token");
  });

  it("does not attach CSRF header on GET requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ id: "u1", username: "demo", e2eeEnabled: false }),
    } as Response);

    await api.auth.me();

    const [, options] = fetchMock.mock.calls[0];
    expect((options?.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
  });

  it("surfaces backend error messages", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      statusText: "Bad Request",
      json: async () => ({ error: "Invalid username or password" }),
    } as Response);

    await expect(api.auth.login("bad", "bad")).rejects.toThrow("Invalid username or password");
  });
});

describe("api.passkeys", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.cookie = "stokely-csrf=test-csrf-token; path=/";
  });

  it("loginBegin POSTs to /api/auth/passkey/begin without CSRF (unauthenticated)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ publicKey: {} }),
    } as Response);

    await api.passkeys.loginBegin();

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/auth/passkey/begin");
    expect((options as RequestInit).method).toBe("POST");
  });

  it("loginFinish POSTs assertion body to /api/auth/passkey/finish", async () => {
    const assertion = { id: "cred-id", rawId: "rawId", type: "public-key" };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ id: "u1", username: "alice" }),
    } as Response);

    await api.passkeys.loginFinish(assertion);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/auth/passkey/finish");
    expect((options as RequestInit).method).toBe("POST");
    expect((options as RequestInit).body).toBe(JSON.stringify(assertion));
  });

  it("loginFinish attaches CSRF header when cookie is present", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ id: "u1", username: "alice" }),
    } as Response);

    await api.passkeys.loginFinish({});

    const [, options] = fetchMock.mock.calls[0];
    expect((options?.headers as Record<string, string>)["X-CSRF-Token"]).toBe("test-csrf-token");
  });

  it("registerBegin POSTs to /api/passkeys/register/begin with CSRF", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ publicKey: {} }),
    } as Response);

    await api.passkeys.registerBegin();

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/passkeys/register/begin");
    expect((options as RequestInit).method).toBe("POST");
    expect((options?.headers as Record<string, string>)["X-CSRF-Token"]).toBe("test-csrf-token");
  });

  it("registerFinish POSTs credential and name as query param", async () => {
    const credential = { id: "cred", rawId: "raw", type: "public-key" };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ id: 1, name: "Touch ID" }),
    } as Response);

    await api.passkeys.registerFinish("Touch ID", credential);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/passkeys/register/finish?name=Touch%20ID");
    expect((options as RequestInit).method).toBe("POST");
    expect((options as RequestInit).body).toBe(JSON.stringify(credential));
  });

  it("list GETs /api/passkeys without CSRF", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify([]),
    } as Response);

    await api.passkeys.list();

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/passkeys");
    expect((options as RequestInit).method).toBeUndefined();
    expect((options?.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
  });

  it("delete sends DELETE to /api/passkeys/:id with CSRF", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => "",
    } as Response);

    await api.passkeys.delete(42);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/passkeys/42");
    expect((options as RequestInit).method).toBe("DELETE");
    expect((options?.headers as Record<string, string>)["X-CSRF-Token"]).toBe("test-csrf-token");
  });

  it("rename sends PUT with name body to /api/passkeys/:id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => "",
    } as Response);

    await api.passkeys.rename(7, "Work Laptop");

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/passkeys/7");
    expect((options as RequestInit).method).toBe("PUT");
    expect((options as RequestInit).body).toBe(JSON.stringify({ name: "Work Laptop" }));
  });
});

