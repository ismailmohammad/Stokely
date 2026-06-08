import { api } from '../api/api';

// ── Encoding helpers ──────────────────────────────────────────────────────────

function b64urlToBytes(b64url: string): ArrayBuffer {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    const binary = atob(b64 + pad);
    return Uint8Array.from(binary, c => c.charCodeAt(0)).buffer;
}

function bytesToB64url(buffer: ArrayBuffer): string {
    return btoa(Array.from(new Uint8Array(buffer), b => String.fromCharCode(b)).join(''))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ServerAssertionOptions {
    publicKey: {
        challenge: string;
        rpId?: string;
        allowCredentials?: Array<{ id: string; type: string; transports?: string[] }>;
        userVerification?: UserVerificationRequirement;
        timeout?: number;
    };
}

interface ServerCreationOptions {
    publicKey: {
        rp: { name: string; id: string };
        user: { id: string; name: string; displayName: string };
        challenge: string;
        pubKeyCredParams: Array<{ type: string; alg: number }>;
        timeout?: number;
        excludeCredentials?: Array<{ id: string; type: string; transports?: string[] }>;
        authenticatorSelection?: {
            authenticatorAttachment?: AuthenticatorAttachment;
            residentKey?: ResidentKeyRequirement;
            requireResidentKey?: boolean;
            userVerification?: UserVerificationRequirement;
        };
        attestation?: AttestationConveyancePreference;
    };
}

// ── Passkey support detection ─────────────────────────────────────────────────

export function isWebAuthnAvailable(): boolean {
    return !!(window.PublicKeyCredential && navigator.credentials?.create);
}

/**
 * Returns true if the current browser+platform can create a passkey.
 * Uses the async platform-authenticator check when possible so it correctly
 * returns true on iOS/Android (Face/Touch ID) and Windows Hello, and false on
 * environments where the WebAuthn API exists but no authenticator is present.
 */
export async function isPasskeySupported(): Promise<boolean> {
    if (!isWebAuthnAvailable()) return false;
    try {
        return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
        // Some browsers expose the API but don't implement this check — still try.
        return true;
    }
}

// ── Registration ──────────────────────────────────────────────────────────────

export async function registerPasskey(name: string): Promise<{ id: number; name: string }> {
    if (!isWebAuthnAvailable()) {
        throw new Error('Passkeys are not supported in this browser');
    }

    const serverOptions = await api.passkeys.registerBegin() as ServerCreationOptions;
    const pk = serverOptions.publicKey;

    const createOptions: PublicKeyCredentialCreationOptions = {
        rp: pk.rp,
        user: {
            id: b64urlToBytes(pk.user.id),
            name: pk.user.name,
            displayName: pk.user.displayName,
        },
        challenge: b64urlToBytes(pk.challenge),
        pubKeyCredParams: pk.pubKeyCredParams as PublicKeyCredentialParameters[],
        timeout: pk.timeout ?? 120000,
        excludeCredentials: pk.excludeCredentials?.map(c => ({
            id: b64urlToBytes(c.id),
            type: c.type as PublicKeyCredentialType,
            transports: c.transports as AuthenticatorTransport[] | undefined,
        })) ?? [],
        authenticatorSelection: pk.authenticatorSelection ?? {
            residentKey: 'required',
            userVerification: 'preferred',
        },
        attestation: pk.attestation ?? 'none',
    };

    const credential = await navigator.credentials.create({ publicKey: createOptions }) as PublicKeyCredential | null;
    if (!credential) throw new Error('No credential returned by authenticator');

    const response = credential.response as AuthenticatorAttestationResponse;

    const credentialJSON: Record<string, unknown> = {
        id: credential.id,
        rawId: bytesToB64url(credential.rawId),
        response: {
            clientDataJSON: bytesToB64url(response.clientDataJSON),
            attestationObject: bytesToB64url(response.attestationObject),
            transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
        },
        type: credential.type,
    };

    return api.passkeys.registerFinish(name, credentialJSON);
}

// ── Authentication ────────────────────────────────────────────────────────────

export async function authenticateWithPasskey(): Promise<Record<string, unknown>> {
    if (!isWebAuthnAvailable()) {
        throw new Error('Passkeys are not supported in this browser');
    }

    const serverOptions = await api.passkeys.loginBegin() as ServerAssertionOptions;
    const pk = serverOptions.publicKey;

    const getOptions: PublicKeyCredentialRequestOptions = {
        challenge: b64urlToBytes(pk.challenge),
        rpId: pk.rpId,
        allowCredentials: pk.allowCredentials?.map(c => ({
            id: b64urlToBytes(c.id),
            type: c.type as PublicKeyCredentialType,
            transports: c.transports as AuthenticatorTransport[] | undefined,
        })) ?? [],
        userVerification: pk.userVerification ?? 'preferred',
        timeout: pk.timeout ?? 120000,
    };

    const credential = await navigator.credentials.get({ publicKey: getOptions }) as PublicKeyCredential | null;
    if (!credential) throw new Error('No credential returned by authenticator');

    const response = credential.response as AuthenticatorAssertionResponse;

    return {
        id: credential.id,
        rawId: bytesToB64url(credential.rawId),
        response: {
            clientDataJSON: bytesToB64url(response.clientDataJSON),
            authenticatorData: bytesToB64url(response.authenticatorData),
            signature: bytesToB64url(response.signature),
            userHandle: response.userHandle ? bytesToB64url(response.userHandle) : undefined,
        },
        type: credential.type,
    };
}
