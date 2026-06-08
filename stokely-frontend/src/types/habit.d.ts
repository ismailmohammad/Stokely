export interface HabitType {
    id: number;
    name: string;
    complete: boolean;
    recurrence: string;
    positiveType: boolean;
    icon: string;
    recurrenceEnd?: string;   // ISO date string e.g. "2026-06-01T00:00:00Z"
    notes: string;
    reminderTime: string;     // "HH:MM" in reminder timezone (or legacy UTC when reminderTz is empty)
    reminderTz?: string;
    streak: number;
    hasFreeze: boolean;
    frozenToday: boolean;
    createdAt: string;
    encrypted?: boolean;      // client-side: true when the habit's name/notes are/were E2EE-encrypted
}

export interface UserInfo {
    id: string;
    username: string;
    email?: string;
    emailVerified?: boolean;
    emailPending?: boolean;
    showWelcome?: boolean;
    dailySparkEnabled?: boolean;
    e2eeEnabled?: boolean;
    e2eeSetupPrompt?: boolean;
    hasPasskeys?: boolean;
}

export interface PasskeyInfo {
    id: number;
    name: string;
    createdAt: string;
    lastUsedAt?: string;
}

export type DashboardView = 'daily' | 'all' | 'calendar' | 'streak' | 'achievements';

export interface DayStatus {
    date: string;
    scheduled: boolean;
    completed: boolean;
    frozen: boolean;
}

export interface StreakDetail {
    currentStreak: number;
    longestStreak: number;
    freezeCount: number;
    history: DayStatus[];
}

export interface AchievementType {
    key: string;
    title: string;
    description: string;
    unlocked: boolean;
}

export interface UserSession {
    id: string;
    createdAt: string;
    lastSeenAt: string;
    userAgent: string;
    ipAddress: string;
    isCurrent: boolean;
}

export interface PushSubscriptionDevice {
    id: number;
    endpoint: string;
    userAgent: string;
    deviceLabel: string;
    enabled: boolean;
    createdAt: string;
    lastSeenAt?: string;
    lastSuccessAt?: string;
    lastFailureAt?: string;
    lastFailureCode: number;
    failureCount: number;
}
