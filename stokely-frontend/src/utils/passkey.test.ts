import { beforeEach, describe, expect, it, vi } from "vitest";
import { isWebAuthnAvailable, isPasskeySupported, registerPasskey, authenticateWithPasskey } from "./passkey";

// ── API mock ──────────────────────────────────────────────────────────────────

const registerBeginMock = vi.fn();
const registerFinishMock = vi.fn();
const loginBeginMock = vi.fn();
const loginFinishMock = vi.fn();

vi.mock("../api/api", () => ({
  api: {
    passkeys: {
      registerBegin: (...args: unknown[]) => registerBeginMock(...args),
      registerFinish: (...args: unknown[]) => registerFinishMock(...args),
      loginBegin: (...args: unknown[]) => loginBeginMock(...args),
      loginFinish: (...args: unknown[]) => loginFinishMock(...args),
    },
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Encode a byte array as base64url (no padding). */
function toB64url(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** 32 zero bytes used as a fake challenge / user id. */
const FAKE_BYTES = Array.from({ length: 32 }, () => 0);
const FAKE_B64URL = toB64url(FAKE_BYTES);

function makeServerCreationOptions() {
  return {
    publicKey: {
      rp: { name: "Stokely", id: "localhost" },
      user: { id: FAKE_B64URL, name: "alice", displayName: "alice" },
      challenge: FAKE_B64URL,
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      timeout: 60000,
      excludeCredentials: [],
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      attestation: "none",
    },
  };
}

function makeServerAssertionOptions() {
  return {
    publicKey: {
      challenge: FAKE_B64URL,
      rpId: "localhost",
      allowCredentials: [],
      userVerification: "preferred" as UserVerificationRequirement,
      timeout: 60000,
    },
  };
}

/** Build a mock PublicKeyCredential for registration. */
function makeRegistrationCredential(): PublicKeyCredential {
  const buf = new Uint8Array(8).buffer;
  return {
    id: "cred-id-base64url",
    rawId: buf,
    type: "public-key",
    response: {
      clientDataJSON: buf,
      attestationObject: buf,
      getTransports: () => ["internal"],
    } as AuthenticatorAttestationResponse,
    getClientExtensionResults: () => ({}),
    authenticatorAttachment: "platform",
  } as unknown as PublicKeyCredential;
}

/** Build a mock PublicKeyCredential for authentication. */
function makeAssertionCredential(): PublicKeyCredential {
  const buf = new Uint8Array(8).buffer;
  return {
    id: "cred-id-base64url",
    rawId: buf,
    type: "public-key",
    response: {
      clientDataJSON: buf,
      authenticatorData: buf,
      signature: buf,
      userHandle: buf,
    } as AuthenticatorAssertionResponse,
    getClientExtensionResults: () => ({}),
    authenticatorAttachment: "platform",
  } as unknown as PublicKeyCredential;
}

// ── isWebAuthnAvailable ───────────────────────────────────────────────────────

describe("isWebAuthnAvailable", () => {
  it("returns true when both PublicKeyCredential and credentials.create exist", () => {
    Object.defineProperty(window, "PublicKeyCredential", { value: class {}, configurable: true });
    Object.defineProperty(navigator, "credentials", {
      value: { create: vi.fn() },
      configurable: true,
    });
    expect(isWebAuthnAvailable()).toBe(true);
  });

  it("returns false when PublicKeyCredential is missing", () => {
    Object.defineProperty(window, "PublicKeyCredential", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "credentials", {
      value: { create: vi.fn() },
      configurable: true,
    });
    expect(isWebAuthnAvailable()).toBe(false);
  });

  it("returns false when navigator.credentials is missing", () => {
    Object.defineProperty(window, "PublicKeyCredential", { value: class {}, configurable: true });
    Object.defineProperty(navigator, "credentials", { value: undefined, configurable: true });
    expect(isWebAuthnAvailable()).toBe(false);
  });
});

// ── isPasskeySupported ────────────────────────────────────────────────────────

describe("isPasskeySupported", () => {
  beforeEach(() => {
    Object.defineProperty(window, "PublicKeyCredential", { value: class {}, configurable: true });
    Object.defineProperty(navigator, "credentials", {
      value: { create: vi.fn() },
      configurable: true,
    });
  });

  it("returns false immediately when WebAuthn is not available", async () => {
    Object.defineProperty(window, "PublicKeyCredential", { value: undefined, configurable: true });
    await expect(isPasskeySupported()).resolves.toBe(false);
  });

  it("returns true when isUserVerifyingPlatformAuthenticatorAvailable resolves true", async () => {
    Object.defineProperty(window, "PublicKeyCredential", {
      value: {
        isUserVerifyingPlatformAuthenticatorAvailable: vi.fn().mockResolvedValue(true),
      },
      configurable: true,
    });
    await expect(isPasskeySupported()).resolves.toBe(true);
  });

  it("returns false when isUserVerifyingPlatformAuthenticatorAvailable resolves false", async () => {
    Object.defineProperty(window, "PublicKeyCredential", {
      value: {
        isUserVerifyingPlatformAuthenticatorAvailable: vi.fn().mockResolvedValue(false),
      },
      configurable: true,
    });
    await expect(isPasskeySupported()).resolves.toBe(false);
  });

  it("returns true as fallback when isUserVerifyingPlatformAuthenticatorAvailable throws", async () => {
    Object.defineProperty(window, "PublicKeyCredential", {
      value: {
        isUserVerifyingPlatformAuthenticatorAvailable: vi.fn().mockRejectedValue(new Error("not impl")),
      },
      configurable: true,
    });
    await expect(isPasskeySupported()).resolves.toBe(true);
  });
});

// ── registerPasskey ───────────────────────────────────────────────────────────

describe("registerPasskey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "PublicKeyCredential", { value: class {}, configurable: true });
    // Include both `create` and `get` so tests that override one field don't
    // accidentally remove the other, and `isWebAuthnAvailable()` keeps returning true.
    Object.defineProperty(navigator, "credentials", {
      value: {
        create: vi.fn().mockResolvedValue(makeRegistrationCredential()),
        get: vi.fn(),
      },
      configurable: true,
    });
    registerBeginMock.mockResolvedValue(makeServerCreationOptions());
    registerFinishMock.mockResolvedValue({ id: 1, name: "My Key" });
  });

  it("throws when WebAuthn is not available", async () => {
    Object.defineProperty(window, "PublicKeyCredential", { value: undefined, configurable: true });
    await expect(registerPasskey("My Key")).rejects.toThrow("not supported");
  });

  it("calls registerBegin, creates credential, then calls registerFinish with the name", async () => {
    registerBeginMock.mockResolvedValue(makeServerCreationOptions());
    registerFinishMock.mockResolvedValue({ id: 1, name: "My Key" });

    const result = await registerPasskey("My Key");

    expect(registerBeginMock).toHaveBeenCalledTimes(1);
    expect(navigator.credentials.create).toHaveBeenCalledTimes(1);
    expect(registerFinishMock).toHaveBeenCalledTimes(1);

    const [name, credential] = registerFinishMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("My Key");
    expect(credential).toHaveProperty("id");
    expect(credential).toHaveProperty("rawId");
    expect(credential).toHaveProperty("type", "public-key");
    expect((credential.response as Record<string, unknown>)).toHaveProperty("clientDataJSON");
    expect((credential.response as Record<string, unknown>)).toHaveProperty("attestationObject");

    expect(result).toEqual({ id: 1, name: "My Key" });
  });

  it("passes the credential options decoded from base64url to navigator.credentials.create", async () => {
    registerBeginMock.mockResolvedValue(makeServerCreationOptions());
    registerFinishMock.mockResolvedValue({ id: 2, name: "Key" });

    await registerPasskey("Key");

    const createOptions = (navigator.credentials.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as { publicKey: PublicKeyCredentialCreationOptions };
    expect(createOptions.publicKey.challenge).toBeInstanceOf(ArrayBuffer);
    expect(createOptions.publicKey.user.id).toBeInstanceOf(ArrayBuffer);
  });

  it("throws when navigator.credentials.create returns null", async () => {
    Object.defineProperty(navigator, "credentials", {
      value: { create: vi.fn().mockResolvedValue(null), get: vi.fn() },
      configurable: true,
    });
    await expect(registerPasskey("Key")).rejects.toThrow();
    expect(registerFinishMock).not.toHaveBeenCalled();
  });

  it("propagates errors from navigator.credentials.create without calling registerFinish", async () => {
    const error = Object.assign(new Error("user cancelled"), { name: "NotAllowedError" });
    Object.defineProperty(navigator, "credentials", {
      value: { create: vi.fn().mockRejectedValue(error), get: vi.fn() },
      configurable: true,
    });
    await expect(registerPasskey("Key")).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(registerFinishMock).not.toHaveBeenCalled();
  });
});

// ── authenticateWithPasskey ───────────────────────────────────────────────────

describe("authenticateWithPasskey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Both `create` and `get` must be present so `isWebAuthnAvailable()` (which
    // checks `.create`) returns true AND individual tests that override `get` still
    // see a valid `credentials` object.
    Object.defineProperty(window, "PublicKeyCredential", { value: class {}, configurable: true });
    Object.defineProperty(navigator, "credentials", {
      value: {
        create: vi.fn(),
        get: vi.fn().mockResolvedValue(makeAssertionCredential()),
      },
      configurable: true,
    });
    loginBeginMock.mockResolvedValue(makeServerAssertionOptions());
    loginFinishMock.mockResolvedValue({ id: "u1", username: "alice" });
  });

  it("throws when WebAuthn is not available", async () => {
    Object.defineProperty(window, "PublicKeyCredential", { value: undefined, configurable: true });
    await expect(authenticateWithPasskey()).rejects.toThrow("not supported");
  });

  it("calls loginBegin, gets credential, then returns assertion JSON", async () => {
    loginBeginMock.mockResolvedValue(makeServerAssertionOptions());
    loginFinishMock.mockResolvedValue({ id: "u1", username: "alice" });

    await authenticateWithPasskey();

    expect(loginBeginMock).toHaveBeenCalledTimes(1);
    expect(navigator.credentials.get).toHaveBeenCalledTimes(1);
  });

  it("passes decoded challenge ArrayBuffer to navigator.credentials.get", async () => {
    loginBeginMock.mockResolvedValue(makeServerAssertionOptions());

    await authenticateWithPasskey();

    const getOptions = (navigator.credentials.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as { publicKey: PublicKeyCredentialRequestOptions };
    expect(getOptions.publicKey.challenge).toBeInstanceOf(ArrayBuffer);
  });

  it("returns assertion with base64url-encoded fields", async () => {
    loginBeginMock.mockResolvedValue(makeServerAssertionOptions());
    loginFinishMock.mockResolvedValue({ id: "u1", username: "alice" });

    const result = await authenticateWithPasskey();
    expect(result).toHaveProperty("id");
    expect(result).toHaveProperty("rawId");
    expect(result).toHaveProperty("type", "public-key");
    const response = result.response as Record<string, unknown>;
    expect(response).toHaveProperty("clientDataJSON");
    expect(response).toHaveProperty("authenticatorData");
    expect(response).toHaveProperty("signature");
  });

  it("throws when navigator.credentials.get returns null", async () => {
    Object.defineProperty(navigator, "credentials", {
      value: { create: vi.fn(), get: vi.fn().mockResolvedValue(null) },
      configurable: true,
    });
    await expect(authenticateWithPasskey()).rejects.toThrow();
  });

  it("propagates NotAllowedError from navigator.credentials.get", async () => {
    const error = Object.assign(new Error("cancelled"), { name: "NotAllowedError" });
    Object.defineProperty(navigator, "credentials", {
      value: { create: vi.fn(), get: vi.fn().mockRejectedValue(error) },
      configurable: true,
    });
    await expect(authenticateWithPasskey()).rejects.toMatchObject({ name: "NotAllowedError" });
  });
});
