import type { HabitType, UserInfo, DashboardView, StreakDetail, AchievementType, PushSubscriptionDevice, UserSession, PasskeyInfo } from '../types/habit';

const BASE = '/api';

function getCookie(name: string): string | null {
    const encodedName = `${encodeURIComponent(name)}=`;
    const parts = document.cookie.split(';');
    for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.startsWith(encodedName)) {
            return decodeURIComponent(trimmed.slice(encodedName.length));
        }
    }
    return null;
}

async function req<T>(path: string, options?: RequestInit): Promise<T> {
    const method = (options?.method ?? 'GET').toUpperCase();
    const csrfToken = getCookie('stokely-csrf');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
    }
    const res = await fetch(`${BASE}${path}`, {
        credentials: 'include',
        cache: 'no-store',
        headers: {
            ...headers,
            ...(options?.headers as Record<string, string> | undefined),
        },
        ...options,
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || res.statusText);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : ({} as T);
}

export const api = {
    auth: {
        login: (username: string, password: string) =>
            req<UserInfo>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
        register: (username: string, password: string, email?: string) =>
            req<UserInfo>('/auth/register', { method: 'POST', body: JSON.stringify({ username, password, email: email || undefined }) }),
        logout: () => req<void>('/auth/logout', { method: 'POST' }),
        me: () => req<UserInfo>('/auth/me'),
        changePassword: (currentPassword: string, newPassword: string) =>
            req<void>('/auth/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) }),
        markWelcomeSeen: () => req<void>('/auth/welcome-seen', { method: 'POST' }),
        setDailySparkEnabled: (enabled: boolean) =>
            req<{ dailySparkEnabled: boolean }>('/auth/daily-spark', { method: 'PUT', body: JSON.stringify({ enabled }) }),
        sendVerifyEmail: (email: string) =>
            req<void>('/auth/email/verify', { method: 'POST', body: JSON.stringify({ email }) }),
        removeEmail: () =>
            req<void>('/auth/email', { method: 'DELETE', body: JSON.stringify({ confirm: true }) }),
        verifyEmail: (token: string) =>
            req<{ message: string }>('/auth/email/verify?token=' + encodeURIComponent(token)),
        forgotPassword: (username: string) =>
            req<{ message: string }>('/auth/password/forgot', { method: 'POST', body: JSON.stringify({ username }) }),
        resetPassword: (token: string, newPassword: string) =>
            req<{ message: string }>('/auth/password/reset', { method: 'POST', body: JSON.stringify({ token, newPassword }) }),
    },
    habits: {
        list: (view: DashboardView = 'daily', date?: string) =>
            req<HabitType[]>(`/habits?view=${view}${date ? `&date=${date}` : ''}`),
        create: (data: {
            name: string; recurrence: string; positiveType: boolean;
            icon?: string; recurrenceEnd?: string | null; notes?: string; reminderTime?: string; reminderTz?: string;
        }) =>
            req<HabitType>('/habits', { method: 'POST', body: JSON.stringify(data) }),
        update: (id: number, changes: Record<string, unknown>) =>
            req<HabitType>(`/habits/${id}`, { method: 'PUT', body: JSON.stringify(changes) }),
        remove: (id: number) => req<void>(`/habits/${id}`, { method: 'DELETE' }),
        logComplete: (id: number, date?: string) =>
            req<void>(`/habits/${id}/log`, { method: 'POST', body: JSON.stringify({ date: date ?? '' }) }),
        logUncomplete: (id: number, date?: string) =>
            req<void>(`/habits/${id}/log`, { method: 'DELETE', body: JSON.stringify({ date: date ?? '' }) }),
        getStreak: (id: number) =>
            req<StreakDetail>(`/habits/${id}/streak`),
        getAchievements: () =>
            req<AchievementType[]>('/habits/achievements'),
    },
    push: {
        getVapidKey: () => req<{ publicKey: string }>('/push/vapid-public'),
        subscribe: (sub: { endpoint: string; p256dh: string; auth: string; deviceLabel?: string }) =>
            req<void>('/push/subscribe', { method: 'POST', body: JSON.stringify(sub) }),
        unsubscribe: (endpoint: string) =>
            req<void>('/push/unsubscribe', { method: 'DELETE', body: JSON.stringify({ endpoint }) }),
        listSubscriptions: () =>
            req<PushSubscriptionDevice[]>('/push/subscriptions'),
        updateSubscription: (id: number, enabled: boolean) =>
            req<void>(`/push/subscriptions/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
        deleteSubscription: (id: number) =>
            req<void>(`/push/subscriptions/${id}`, { method: 'DELETE' }),
        testSubscription: (id: number) =>
            req<{ message: string; statusCode: number }>(`/push/subscriptions/${id}/test`, { method: 'POST' }),
    },
    sessions: {
        list: () => req<UserSession[]>('/sessions'),
        logout: (id: string) => req<void>(`/sessions/${id}`, { method: 'DELETE' }),
        logoutOthers: () => req<void>('/sessions/logout-others', { method: 'POST' }),
    },
    user: {
        exportData: () => req<unknown>('/user/export'),
        deleteAccount: (password: string) =>
            req<void>('/user/account', { method: 'DELETE', body: JSON.stringify({ password }) }),
    },
    passkeys: {
        list: () => req<PasskeyInfo[]>('/passkeys'),
        registerBegin: () => req<{ publicKey: Record<string, unknown> }>('/passkeys/register/begin', { method: 'POST' }),
        registerFinish: (name: string, credential: Record<string, unknown>) =>
            req<{ id: number; name: string }>(`/passkeys/register/finish?name=${encodeURIComponent(name)}`, {
                method: 'POST',
                body: JSON.stringify(credential),
            }),
        rename: (id: number, name: string) =>
            req<void>(`/passkeys/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
        delete: (id: number) => req<void>(`/passkeys/${id}`, { method: 'DELETE' }),
        loginBegin: () => req<{ publicKey: Record<string, unknown> }>('/auth/passkey/begin', { method: 'POST' }),
        loginFinish: (assertion: Record<string, unknown>) =>
            req<UserInfo>('/auth/passkey/finish', { method: 'POST', body: JSON.stringify(assertion) }),
    },
    e2ee: {
        status: () => req<{ enabled: boolean; salt?: string; verifier?: string }>('/e2ee'),
        enable: (data: { salt: string; verifier: string; habits: Array<{ id: number; name: string; notes: string }> }) =>
            req<{ enabled: boolean; message: string }>('/e2ee/enable', { method: 'POST', body: JSON.stringify(data) }),
        changePassphrase: (data: { salt: string; verifier: string; habits: Array<{ id: number; name: string; notes: string }> }) =>
            req<void>('/e2ee/passphrase', { method: 'PUT', body: JSON.stringify(data) }),
        disable: (habits: Array<{ id: number; name: string; notes: string }>) =>
            req<void>('/e2ee/disable', { method: 'POST', body: JSON.stringify({ habits }) }),
    },
};
