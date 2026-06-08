import styled, { keyframes } from "styled-components";
import Habit from "./Habit";
import StreakView from "./StreakView";
import AchievementsView from "./AchievementsView";
import { HabitType, DashboardView, AchievementType } from "../../types/habit";
import { useState, useEffect, useRef, useCallback } from "react";
import HabitModal from "./NewHabitModal";
import toast from "react-hot-toast";
import { api } from "../../api/api";
import { useNavigate } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import { setUserInfo } from "../../redux/userSlice";
import type { RootState } from "../../redux/store";
import { useE2EE } from "../../context/E2EEContext";
import { decryptRecursively, encrypt, generateSalt, deriveKey, makeVerifier, isEncrypted } from "../../utils/e2ee";
import { registerPasskey, isWebAuthnAvailable } from "../../utils/passkey";
import VaultUnlockModal from "../VaultUnlockModal";

import CubeRed from '../../assets/cube-logo-red.png';
import CubeRedTop from '../../assets/cube-logo-red-top.png';
import CubeRedRight from '../../assets/cube-logo-red-right.png';
import CubeRedLeft from '../../assets/cube-logo-red-left.png';
import CubeGreen from '../../assets/cube-logo-green.png';
import CubeGreenTop from '../../assets/cube-logo-green-top.png';
import CubeGreenRight from '../../assets/cube-logo-green-right.png';
import CubeGreenLeft from '../../assets/cube-logo-green-left.png';
import FieryGreen from '../../assets/fiery-cube-green.png';
import FieryRed from '../../assets/fiery-cube-red.png';
import BadgeFirstCompletion from '../../assets/kindling/badge_first_completion.png';
import BadgeFirstStreak from '../../assets/kindling/badge_first_streak.png';
import Badge7Day from '../../assets/kindling/badge_7_day_flame.png';
import Badge21Day from '../../assets/kindling/badge_21_day_momentum.png';
import Badge90Day from '../../assets/kindling/badge_90_day_forge.png';
import Badge365Day from '../../assets/kindling/badge_365_day_legend.png';
import WelcomeToStokely from '../../assets/kindling/welcome-to-stokely.png';
import KindleIdeaLeft from '../../assets/kindling/kindle_idea_left.png';
import KindleIdeaRight from '../../assets/kindling/kindle_idea_right.png';
import { DAILY_SPARK_LIBRARY } from '../../assets/kindling/dailySparks';

interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const negativeLogos = [CubeRedTop, CubeRedRight, CubeRedLeft];
const positiveLogos = [CubeGreenLeft, CubeGreenRight, CubeGreenTop];

function getRandomCubeLogo(positive: boolean): string {
    const images = positive ? positiveLogos : negativeLogos;
    return images[Math.floor(Math.random() * images.length)];
}

function todayISO(): string {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function randomItem<T>(items: T[]): T {
    return items[Math.floor(Math.random() * items.length)];
}

const ALL_TAB_PAGE_SIZE = 20;
const ACHIEVEMENT_SEEN_KEY_PREFIX = 'stokely_seen_achievements_v1';
const INSTALL_PROMPT_DISMISSED_KEY_PREFIX = 'stokely_install_prompt_dismissed_v1';
const PASSKEY_PROMPT_DISMISSED_KEY_PREFIX = 'stokely_passkey_prompt_dismissed_v1';
const DAILY_SPARK_IMAGES = [KindleIdeaLeft, KindleIdeaRight];
const ACHIEVEMENT_ORDER: AchievementType[] = [
    { key: 'first_completion', title: 'First Completion', description: 'Complete your first habit log.', unlocked: false },
    { key: 'first_streak', title: 'First Streak', description: 'Reach your first 2-day streak.', unlocked: false },
    { key: 'streak_7', title: '7 Day Flame', description: 'Reach a 7-day streak on any habit.', unlocked: false },
    { key: 'streak_21', title: '21 Day Momentum', description: 'Reach a 21-day streak on any habit.', unlocked: false },
    { key: 'streak_90', title: '90 Day Forge', description: 'Reach a 90-day streak on any habit.', unlocked: false },
    { key: 'streak_365', title: '365 Day Legend', description: 'Reach a 365-day streak on any habit.', unlocked: false },
];

const ACHIEVEMENT_BADGES: Record<string, string> = {
    first_completion: BadgeFirstCompletion,
    first_streak: BadgeFirstStreak,
    streak_7: Badge7Day,
    streak_21: Badge21Day,
    streak_90: Badge90Day,
    streak_365: Badge365Day,
};

// ── Animations ─────────────────────────────────────────────────────────────────

const overlayIn = keyframes`from { opacity: 0; } to { opacity: 1; }`;
const overlayOut = keyframes`from { opacity: 1; } to { opacity: 0; }`;
const modalIn = keyframes`
    from { opacity: 0; transform: scale(0.93) translateY(8px); }
    to   { opacity: 1; transform: scale(1)    translateY(0);   }
`;
const modalOut = keyframes`
    from { opacity: 1; transform: scale(1)    translateY(0);   }
    to   { opacity: 0; transform: scale(0.93) translateY(8px); }
`;
const contentFadeIn = keyframes`
    from { opacity: 0; transform: translateY(5px); }
    to   { opacity: 1; transform: translateY(0);   }
`;
const tabPulse = keyframes`
    0% { box-shadow: 0 0 0 rgba(45, 202, 142, 0); }
    18% { box-shadow: 0 0 16px rgba(45, 202, 142, 0.65); }
    36% { box-shadow: 0 0 0 rgba(45, 202, 142, 0); }
    55% { box-shadow: 0 0 0 rgba(45, 202, 142, 0); }
    73% { box-shadow: 0 0 16px rgba(45, 202, 142, 0.65); }
    91% { box-shadow: 0 0 0 rgba(45, 202, 142, 0); }
    100% { box-shadow: 0 0 0 rgba(45, 202, 142, 0); }
`;
const unlockBadgeFade = keyframes`
    0% { opacity: 0; transform: translateX(-50%) translateY(-10px) scale(0.96); }
    12% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
    82% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
    100% { opacity: 0; transform: translateX(-50%) translateY(-8px) scale(0.98); }
`;
const bubbleIn = keyframes`
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
`;

// ── Styled components ──────────────────────────────────────────────────────────

const Page = styled.div`
    max-width: 900px;
    margin: 0 auto;
    padding: 1.5rem 1rem;
    animation: page-fade-in 0.22s ease-out;
    box-sizing: border-box;
    width: 100%;

    @media (max-width: 480px) {
        padding: 1rem 0.75rem;
    }
`;

const PageHeader = styled.div`
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 1rem;
    margin-bottom: 1rem;
`;

const PageTitle = styled.div``;

const DayLabel = styled.p`
    color: #888;
    margin: 0.25rem 0 0;
    font-size: 0.95rem;
`;

const AddButton = styled.button`
    background: #2dca8e;
    color: #111;
    font-weight: 700;
    border: none;
    border-radius: 10px;
    padding: 0.6rem 1.25rem;
    font-size: 0.95rem;
    cursor: pointer;
    transition: background 0.2s;
    white-space: nowrap;
    flex-shrink: 0;
    &:hover { background: #25b07b; }
`;

const ViewTabBar = styled.div`
    display: flex;
    gap: 0;
    margin-bottom: 1.25rem;
    border-bottom: 1px solid #2a2a2a;
    padding-bottom: 0;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    &::-webkit-scrollbar { display: none; }
    /* negative margin trick so border goes full width even with padding on Page */
    flex-shrink: 0;
`;

const ViewTab = styled.button<{ $active: boolean; $highlight?: boolean }>`
    background: none;
    border: none;
    color: ${p => p.$active ? '#2dca8e' : '#666'};
    font-size: 0.9rem;
    font-weight: ${p => p.$active ? '600' : '400'};
    padding: 0.5rem 0.85rem;
    cursor: pointer;
    border-bottom: 2px solid ${p => p.$active ? '#2dca8e' : 'transparent'};
    margin-bottom: -1px;
    transition: color 0.15s, border-color 0.15s;
    white-space: nowrap;
    flex-shrink: 0;
    &:hover { color: ${p => p.$active ? '#2dca8e' : '#aaa'}; }
    animation: ${p => p.$highlight ? tabPulse : 'none'} 2.4s ease;

    @media (max-width: 480px) {
        font-size: 0.82rem;
        padding: 0.45rem 0.65rem;
    }
`;

const CalendarInput = styled.input`
    background: #1e1e1e;
    color: white;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 0.4rem 0.75rem;
    font-size: 0.9rem;
    margin-bottom: 0;
    color-scheme: dark;
    cursor: pointer;
`;

const CalendarControls = styled.div`
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
`;

const CalendarResetBtn = styled.button`
    background: #2a2a2a;
    color: #ddd;
    border: 1px solid #444;
    border-radius: 8px;
    padding: 0.4rem 0.75rem;
    min-height: 33px;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;

    &:hover {
        background: #333;
        border-color: #5a5a5a;
    }
`;

const LazyLoadSentinel = styled.div`
    height: 28px;
    margin-top: 0.5rem;
`;

const SearchInput = styled.input`
    width: 100%;
    background: #1b1b1b;
    color: #f1f1f1;
    border: 1px solid #333;
    border-radius: 10px;
    padding: 0.58rem 0.8rem;
    font-size: 0.9rem;
    margin-bottom: 0;
    box-sizing: border-box;
    transition: border-color 0.15s ease;

    &::placeholder {
        color: #6f6f6f;
    }

    &:focus {
        outline: none;
        border-color: #2dca8e;
    }
`;

const SearchWrap = styled.div`
    position: relative;
    margin-bottom: 0.85rem;
`;

const SearchClearBtn = styled.button`
    position: absolute;
    right: 0.5rem;
    top: 50%;
    transform: translateY(-50%);
    width: 1.35rem;
    height: 1.35rem;
    border: none;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
    font-size: 0.8rem;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition: background 0.15s ease;

    &:hover {
        background: rgba(255, 255, 255, 0.2);
    }
`;

const HabitsContainer = styled.div`
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
`;

const EmptyState = styled.div`
    text-align: center;
    padding: 4rem 1rem;
    color: #666;
    background: #1a1a1a;
    border: 1px dashed #333;
    border-radius: 12px;
`;

const LoadingDots = styled.div`
    text-align: center;
    padding: 4rem 1rem;
    color: #555;
    font-size: 0.9rem;

    &::after {
        content: '';
        display: inline-block;
        animation: dots 1.2s steps(3, end) infinite;
    }

    @keyframes dots {
        0%   { content: ''; }
        33%  { content: '.'; }
        66%  { content: '..'; }
        100% { content: '...'; }
    }
`;

const ContentArea = styled.div`
    animation: ${contentFadeIn} 0.22s ease-out;
`;

const SectionLabel = styled.h2`
    font-size: 0.8rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #666;
    margin: 1.5rem 0 0.5rem;
`;

const UnlockToast = styled.div`
    position: fixed;
    top: 5.2rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 320;
    background: rgba(18, 18, 18, 0.92);
    border: 1px solid #3a3a3a;
    border-radius: 14px;
    padding: 0.65rem 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    animation: ${unlockBadgeFade} 2.4s ease forwards;
    pointer-events: none;
`;

const UnlockToastImg = styled.img`
    width: 40px;
    height: 40px;
    object-fit: contain;
`;

const UnlockToastText = styled.p`
    margin: 0;
    color: #fff;
    font-size: 0.82rem;
    font-weight: 700;
`;

const WelcomeOverlay = styled.div`
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.68);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 340;
    padding: 1rem;
`;

const WelcomeCard = styled.div`
    width: min(720px, 100%);
    background: linear-gradient(
        160deg,
        rgba(52, 52, 52, 0.32),
        rgba(24, 24, 24, 0.24)
    );
    border: 1px solid rgba(255, 255, 255, 0.22);
    box-shadow:
        0 18px 40px rgba(0, 0, 0, 0.45),
        inset 0 1px 0 rgba(255, 255, 255, 0.14);
    border-radius: clamp(1rem, 2vw, 1.6rem);
    padding: clamp(0.8rem, 1.5vw, 1.15rem);
    overflow: hidden;
    backdrop-filter: blur(12px) saturate(125%);
`;

const WelcomeImage = styled.img`
    max-width: 50%;
    max-height: 62vh;
    object-fit: contain;
    border-radius: clamp(0.85rem, 1.4vw, 1.25rem);
    background: rgba(0, 0, 0, 0.16);
    border: 1px solid rgba(255, 255, 255, 0.12);
    display: block;
    margin: 0 auto;
`;

const DailySparkImage = styled.img`
    max-width: 50%;
    max-height: 62vh;
    object-fit: contain;
    display: block;
    margin: 0 auto;
`;

const WelcomeBubble = styled.div`
    position: relative;
    margin-top: 0.95rem;
    background: linear-gradient(155deg, rgba(22, 22, 22, 0.94), rgba(14, 14, 14, 0.9));
    border: 1px solid rgba(68, 224, 162, 0.42);
    color: #fff;
    border-radius: 14px;
    padding: 0.85rem 1rem;
    box-shadow:
        0 10px 26px rgba(0, 0, 0, 0.35),
        inset 0 1px 0 rgba(255, 255, 255, 0.08);
    line-height: 1.45;
    animation: ${bubbleIn} 0.45s ease forwards;

    &::before {
        content: '';
        position: absolute;
        top: -10px;
        left: 50%;
        width: 16px;
        height: 16px;
        background: rgba(20, 20, 20, 0.95);
        border-left: 1px solid rgba(68, 224, 162, 0.42);
        border-top: 1px solid rgba(68, 224, 162, 0.42);
        transform: translateX(-50%) rotate(45deg);
    }
`;

const WelcomeSpeaker = styled.p`
    margin: 0 0 0.22rem;
    color: #2dca8e;
    font-size: 0.77rem;
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
`;

const WelcomeSpeech = styled.p`
    margin: 0;
    color: #f4f4f4;
    font-size: 0.96rem;
    font-weight: 650;
`;

const DailySparkTitle = styled.p`
    margin: 0 0 0.22rem;
    color: #ffc46b;
    font-size: 0.77rem;
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
`;

const WelcomeActions = styled.div`
    margin-top: 0.8rem;
    display: flex;
    justify-content: flex-end;
`;

const WelcomeDismissBtn = styled.button`
    background: #2a2a2a;
    color: #fff;
    border: 1px solid #454545;
    border-radius: 8px;
    padding: 0.45rem 0.8rem;
    font-size: 0.84rem;
    font-weight: 700;
    cursor: pointer;
`;

const InstallTitle = styled.p`
    margin: 0 0 0.35rem;
    color: #2dca8e;
    font-size: 0.98rem;
    font-weight: 800;
`;

const InstallText = styled.p`
    margin: 0;
    color: #e9e9e9;
    font-size: 0.92rem;
    line-height: 1.45;
`;

const InstallActions = styled.div`
    margin-top: 0.85rem;
    display: flex;
    justify-content: flex-end;
    gap: 0.45rem;
`;

const InstallBtn = styled.button`
    background: #2dca8e;
    color: #111;
    border: none;
    border-radius: 8px;
    padding: 0.48rem 0.9rem;
    font-size: 0.84rem;
    font-weight: 800;
    cursor: pointer;
`;

const E2EEPromptOverlay = styled(WelcomeOverlay)`
    z-index: 345;
`;

const E2EEPromptCard = styled(WelcomeCard)`
    max-width: 520px;
`;

const E2EEPromptInput = styled.input`
    width: 100%;
    box-sizing: border-box;
    margin-top: 0.6rem;
    background: #181818;
    color: #fff;
    border: 1px solid #373737;
    border-radius: 10px;
    padding: 0.62rem 0.75rem;
    font-size: 0.9rem;

    &:focus {
        outline: none;
        border-color: #2dca8e;
    }
`;

const E2EEPromptActions = styled(InstallActions)`
    margin-top: 1rem;
`;

// ── Confirm modal ──────────────────────────────────────────────────────────────

const ConfirmOverlay = styled.div<{ $closing: boolean }>`
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 250;
    padding: 1rem;
    animation: ${p => p.$closing ? overlayOut : overlayIn} 0.18s ease forwards;
`;

const ConfirmBox = styled.div<{ $closing: boolean }>`
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 16px;
    padding: 1.5rem 1.75rem;
    max-width: 360px;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    animation: ${p => p.$closing ? modalOut : modalIn} 0.2s cubic-bezier(0.34, 1.2, 0.64, 1) forwards;
`;

const ConfirmTitle = styled.p`
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
    color: white;
`;

const ConfirmDetail = styled.p`
    margin: 0;
    font-size: 0.875rem;
    color: #888;
    line-height: 1.5;
`;

const ConfirmActions = styled.div`
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.25rem;
`;

const ConfirmBtn = styled.button<{ $primary?: boolean; $danger?: boolean }>`
    border: none;
    border-radius: 8px;
    padding: 0.5rem 1.1rem;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.15s;
    background: ${p => p.$danger ? '#7a1c1c' : p.$primary ? '#2dca8e' : '#2a2a2a'};
    color: ${p => p.$primary ? '#111' : 'white'};
    &:hover { opacity: 0.85; }
`;

// ── Types ──────────────────────────────────────────────────────────────────────

type ConfirmState = {
    title: string;
    detail?: string;
    confirmLabel: string;
    danger?: boolean;
    onConfirm: () => void;
} | null;

type HabitSectionProps = {
    label: string;
    habits: HabitType[];
    getLogo: (h: HabitType) => string;
    onToggleComplete: (h: HabitType) => void;
    onEdit: (h: HabitType) => void;
};

function HabitSection({ label, habits, getLogo, onToggleComplete, onEdit }: HabitSectionProps) {
    if (habits.length === 0) return null;
    return (
        <>
            <SectionLabel>{label}</SectionLabel>
            <HabitsContainer>
                {habits.map(habit => (
                    <Habit
                        key={habit.id}
                        habitData={habit}
                        imgSrc={getLogo(habit)}
                        onToggleComplete={onToggleComplete}
                        onEdit={onEdit}
                    />
                ))}
            </HabitsContainer>
        </>
    );
}

// ── Dashboard ──────────────────────────────────────────────────────────────────

export default function Dashboard() {
    const [habits, setHabits] = useState<HabitType[]>([]);
    const [loading, setLoading] = useState(true);
    const [modalOpen, setModalOpen] = useState(false);
    const [habitToEdit, setHabitToEdit] = useState<HabitType | null>(null);
    const [view, setView] = useState<DashboardView>('daily');
    const [calendarDate, setCalendarDate] = useState<string>(todayISO());
    const [contentKey, setContentKey] = useState(0);
    const [searchQuery, setSearchQuery] = useState('');
    const [achievements, setAchievements] = useState<AchievementType[]>(ACHIEVEMENT_ORDER);
    const [achievementUnlockToast, setAchievementUnlockToast] = useState<AchievementType | null>(null);
    const [highlightAchievementsTab, setHighlightAchievementsTab] = useState(false);
    const [showWelcomeOverlay, setShowWelcomeOverlay] = useState(false);
    const [showDailySparkOverlay, setShowDailySparkOverlay] = useState(false);
    const [dailySparkImage, setDailySparkImage] = useState(KindleIdeaLeft);
    const [dailySparkMessage, setDailySparkMessage] = useState('');
    const [showInstallPrompt, setShowInstallPrompt] = useState(false);
    const [installPlatform, setInstallPlatform] = useState<'ios' | 'android' | null>(null);
    const [deferredInstallPrompt, setDeferredInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
    const [showPasskeyPrompt, setShowPasskeyPrompt] = useState(false);
    const [passkeyPromptDoNotShow, setPasskeyPromptDoNotShow] = useState(false);
    const [passkeyRegistering, setPasskeyRegistering] = useState(false);
    const hasOfferedPasskeyRef = useRef(false);
    const [allVisibleCount, setAllVisibleCount] = useState(ALL_TAB_PAGE_SIZE);
    const [e2eePassphrase, setE2EEPassphrase] = useState('');
    const [e2eePassphraseConfirm, setE2EEPassphraseConfirm] = useState('');
    const [e2eeSetupLoading, setE2EESetupLoading] = useState(false);
    const allLoadMoreRef = useRef<HTMLDivElement | null>(null);
    const hasShownDailySparkRef = useRef(false);
    const hadWelcomeOverlayRef = useRef(false);

    const [confirmState, setConfirmState] = useState<ConfirmState>(null);
    const [confirmClosing, setConfirmClosing] = useState(false);

    const navigate = useNavigate();
    const dispatch = useDispatch();
    const userInfo = useSelector((state: RootState) => state.user.userInfo);
    const { key: e2eeKey, isUnlocked, unlock: e2eeUnlock } = useE2EE();
    const [vaultModalOpen, setVaultModalOpen] = useState(false);
    const achievementSeenKey = userInfo?.id
        ? `${ACHIEVEMENT_SEEN_KEY_PREFIX}_${userInfo.id}`
        : null;
    const installPromptDismissedKey = userInfo?.id
        ? `${INSTALL_PROMPT_DISMISSED_KEY_PREFIX}_${userInfo.id}`
        : null;
    const passkeyPromptDismissedKey = userInfo?.id
        ? `${PASSKEY_PROMPT_DISMISSED_KEY_PREFIX}_${userInfo.id}`
        : null;

    const [logoMap] = useState<Map<number, string>>(new Map());

    function getLogo(habit: HabitType): string {
        if (habit.streak >= 2) return habit.positiveType ? FieryGreen : FieryRed;
        if (habit.complete) return habit.positiveType ? CubeGreen : CubeRed;
        if (!logoMap.has(habit.id)) {
            logoMap.set(habit.id, getRandomCubeLogo(habit.positiveType));
        }
        return logoMap.get(habit.id)!;
    }

    async function decryptHabits(raw: HabitType[], key: CryptoKey): Promise<HabitType[]> {
        return Promise.all(raw.map(async h => ({
            ...h,
            encrypted: isEncrypted(h.name),
            name: isEncrypted(h.name)
                ? await decryptRecursively(key, h.name).catch(() => h.name)
                : h.name,
            notes: isEncrypted(h.notes)
                ? await decryptRecursively(key, h.notes).catch(() => h.notes)
                : h.notes,
        })));
    }

    function maskLockedHabits(raw: HabitType[]): HabitType[] {
        return raw.map(h => ({
            ...h,
            encrypted: isEncrypted(h.name),
            name: isEncrypted(h.name) ? '🔒 Encrypted' : h.name,
            notes: isEncrypted(h.notes) ? '' : h.notes,
        }));
    }

    useEffect(() => {
        let cancelled = false;
        async function load() {
            if (!cancelled) setLoading(true);
            try {
                if (!userInfo) {
                    const me = await api.auth.me();
                    if (!cancelled) dispatch(setUserInfo(me));
                }
                const date = view === 'calendar' ? calendarDate : (view === 'daily' ? todayISO() : undefined);
                const listView = view === 'streak' || view === 'achievements' ? 'all' : view;
                const [data, achievementData] = await Promise.all([
                    api.habits.list(listView, date),
                    api.habits.getAchievements(),
                ]);
                const processed = e2eeKey
                    ? await decryptHabits(data, e2eeKey)
                    : maskLockedHabits(data);
                if (!cancelled) {
                    setHabits(processed);
                    setAchievements(achievementData);
                    setContentKey(k => k + 1);
                }
            } catch {
                if (!cancelled) navigate("/login");
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        load();
        return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [view, calendarDate, dispatch, navigate, userInfo, isUnlocked]);

    const effectiveDate = view === 'calendar' ? calendarDate : todayISO();

    const dismissConfirm = () => {
        setConfirmClosing(true);
        setTimeout(() => { setConfirmState(null); setConfirmClosing(false); }, 180);
    };

    const showConfirm = (state: ConfirmState) => {
        setConfirmClosing(false);
        setConfirmState(state);
    };

    useEffect(() => {
        if (!confirmState) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') dismissConfirm();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [confirmState]);

    useEffect(() => {
        if (achievements.length === 0 || !achievementSeenKey) return;
        let seen = new Set<string>();
        try {
            const seenRaw = localStorage.getItem(achievementSeenKey);
            seen = new Set<string>(seenRaw ? JSON.parse(seenRaw) as string[] : []);
        } catch {
            seen = new Set<string>();
        }
        const newlyUnlocked = achievements.filter(a => a.unlocked && !seen.has(a.key));
        if (newlyUnlocked.length === 0) return;

        setAchievementUnlockToast(newlyUnlocked[0]);
        setHighlightAchievementsTab(true);

        const nextSeen = new Set(seen);
        newlyUnlocked.forEach(a => nextSeen.add(a.key));
        try {
            localStorage.setItem(achievementSeenKey, JSON.stringify(Array.from(nextSeen)));
        } catch {
            // ignore storage failures
        }

        const hideToast = setTimeout(() => setAchievementUnlockToast(null), 2400);
        const stopHighlight = setTimeout(() => setHighlightAchievementsTab(false), 4300);
        return () => {
            clearTimeout(hideToast);
            clearTimeout(stopHighlight);
        };
    }, [achievements, achievementSeenKey]);

    useEffect(() => {
        if (!userInfo?.showWelcome) return;
        hadWelcomeOverlayRef.current = true;
        setShowWelcomeOverlay(true);
    }, [userInfo?.id, userInfo?.showWelcome]);

    const dismissWelcomeOverlay = useCallback(async () => {
        setShowWelcomeOverlay(false);
        try {
            await api.auth.markWelcomeSeen();
        } catch {
            // ignore
        }
        if (userInfo?.showWelcome) {
            dispatch(setUserInfo({ ...userInfo, showWelcome: false }));
        }
    }, [dispatch, userInfo]);

    useEffect(() => {
        if (!showWelcomeOverlay) return;
        hadWelcomeOverlayRef.current = true;
        setShowDailySparkOverlay(false);
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') void dismissWelcomeOverlay();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
        };
    }, [dismissWelcomeOverlay, showWelcomeOverlay]);

    const [sparkJustCompleted, setSparkJustCompleted] = useState(false);

    const dismissDailySparkOverlay = useCallback(() => {
        setShowDailySparkOverlay(false);
        setSparkJustCompleted(true);
    }, []);

    const dismissInstallPrompt = useCallback(() => {
        setShowInstallPrompt(false);
        if (!installPromptDismissedKey) return;
        try {
            localStorage.setItem(installPromptDismissedKey, '1');
        } catch {
            // ignore storage failures
        }
    }, [installPromptDismissedKey]);

    useEffect(() => {
        if (!userInfo?.id) {
            hasShownDailySparkRef.current = false;
            hadWelcomeOverlayRef.current = false;
            setShowDailySparkOverlay(false);
        }
    }, [userInfo?.id]);

    useEffect(() => {
        if (!userInfo?.id || showWelcomeOverlay || userInfo?.showWelcome) return;
        if (userInfo.dailySparkEnabled === false) return;
        if (hadWelcomeOverlayRef.current || hasShownDailySparkRef.current) return;
        hasShownDailySparkRef.current = true;
        setDailySparkImage(randomItem(DAILY_SPARK_IMAGES));
        setDailySparkMessage(randomItem(DAILY_SPARK_LIBRARY));
        setShowDailySparkOverlay(true);
    }, [showWelcomeOverlay, userInfo?.id, userInfo?.showWelcome, userInfo?.dailySparkEnabled]);

    useEffect(() => {
        if (userInfo?.dailySparkEnabled === false) {
            setShowDailySparkOverlay(false);
        }
    }, [userInfo?.dailySparkEnabled]);

    useEffect(() => {
        if (!installPromptDismissedKey) return;

        const nav = window.navigator as Navigator & { standalone?: boolean };
        const isStandalone = window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
        if (isStandalone) return;

        let dismissed = false;
        try {
            dismissed = localStorage.getItem(installPromptDismissedKey) === '1';
        } catch {
            dismissed = false;
        }
        if (dismissed) return;

        const ua = navigator.userAgent || '';
        const isAndroid = /android/i.test(ua);
        const isIOS = /iPad|iPhone|iPod/.test(ua) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        if (!isAndroid && !isIOS) return;

        setInstallPlatform(isIOS ? 'ios' : 'android');

        let promptTimer: number | null = null;
        if (isIOS) {
            promptTimer = window.setTimeout(() => setShowInstallPrompt(true), 900);
        } else {
            promptTimer = window.setTimeout(() => setShowInstallPrompt(true), 1200);
        }

        const onBeforeInstallPrompt = (event: Event) => {
            const e = event as BeforeInstallPromptEvent;
            e.preventDefault();
            setDeferredInstallPrompt(e);
            setShowInstallPrompt(true);
        };

        const onAppInstalled = () => {
            dismissInstallPrompt();
            setDeferredInstallPrompt(null);
        };

        window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
        window.addEventListener('appinstalled', onAppInstalled);
        return () => {
            if (promptTimer !== null) window.clearTimeout(promptTimer);
            window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
            window.removeEventListener('appinstalled', onAppInstalled);
        };
    }, [dismissInstallPrompt, installPromptDismissedKey]);

    const triggerAndroidInstall = useCallback(async () => {
        if (!deferredInstallPrompt) {
            dismissInstallPrompt();
            return;
        }
        try {
            await deferredInstallPrompt.prompt();
            await deferredInstallPrompt.userChoice;
        } finally {
            setDeferredInstallPrompt(null);
            dismissInstallPrompt();
        }
    }, [deferredInstallPrompt, dismissInstallPrompt]);

    useEffect(() => {
        if (!showDailySparkOverlay || showWelcomeOverlay) return;
        const timer = window.setTimeout(() => dismissDailySparkOverlay(), 4000);
        return () => window.clearTimeout(timer);
    }, [dismissDailySparkOverlay, showDailySparkOverlay, showWelcomeOverlay]);

    useEffect(() => {
        if (!sparkJustCompleted) return;
        setSparkJustCompleted(false);
        if (!userInfo?.id || userInfo.hasPasskeys !== false) return;
        if (!isWebAuthnAvailable() || !passkeyPromptDismissedKey) return;
        if (hasOfferedPasskeyRef.current) return;
        try {
            if (localStorage.getItem(passkeyPromptDismissedKey) === '1') return;
        } catch { return; }
        hasOfferedPasskeyRef.current = true;
        setShowPasskeyPrompt(true);
    }, [sparkJustCompleted, userInfo?.id, userInfo?.hasPasskeys, passkeyPromptDismissedKey]);

    useEffect(() => {
        if (!showDailySparkOverlay || showWelcomeOverlay) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') dismissDailySparkOverlay();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [dismissDailySparkOverlay, showDailySparkOverlay, showWelcomeOverlay]);

    const dismissPasskeyPrompt = useCallback((forever: boolean) => {
        setShowPasskeyPrompt(false);
        setPasskeyPromptDoNotShow(false);
        if (forever && passkeyPromptDismissedKey) {
            try { localStorage.setItem(passkeyPromptDismissedKey, '1'); } catch { /* ignore */ }
        }
    }, [passkeyPromptDismissedKey]);

    const handlePasskeyPromptRegister = useCallback(async () => {
        setPasskeyRegistering(true);
        try {
            await registerPasskey('Passkey');
            setShowPasskeyPrompt(false);
            setPasskeyPromptDoNotShow(false);
            dispatch(setUserInfo({ ...userInfo!, hasPasskeys: true }));
            toast.success('Passkey added — you can manage passkeys in Settings');
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'NotAllowedError') return; // user cancelled
            toast.error(err instanceof Error ? err.message : 'Failed to add passkey');
        } finally {
            setPasskeyRegistering(false);
        }
    }, [dispatch, userInfo]);

    const doToggle = async (habit: HabitType, next: boolean) => {
        setHabits(prev => prev.map(h => h.id === habit.id ? { ...h, complete: next } : h));
        try {
            if (next) {
                await api.habits.logComplete(habit.id, effectiveDate);
            } else {
                await api.habits.logUncomplete(habit.id, effectiveDate);
            }
            const date = view === 'calendar' ? calendarDate : (view === 'daily' ? todayISO() : undefined);
            const listView = view === 'streak' || view === 'achievements' ? 'all' : view;
            const [data, achievementData] = await Promise.all([
                api.habits.list(listView, date),
                api.habits.getAchievements(),
            ]);
            const processed = e2eeKey ? await decryptHabits(data, e2eeKey) : maskLockedHabits(data);
            setHabits(processed);
            setAchievements(achievementData);
            const displayName = habit.encrypted ? 'habit' : `"${habit.name}"`;
            toast.success(next ? `✓ ${displayName} complete` : `↩ ${displayName} reset`);
        } catch (err: unknown) {
            setHabits(prev => prev.map(h => h.id === habit.id ? habit : h));
            toast.error(err instanceof Error ? err.message : "Update failed");
        }
    };

    const handleToggleComplete = (habit: HabitType) => {
        const next = !habit.complete;

        // Revert → show confirm modal
        if (habit.complete) {
            showConfirm({
                title: `Revert "${habit.name}"?`,
                detail: 'This will mark it as incomplete for this date.',
                confirmLabel: 'Revert',
                onConfirm: () => { dismissConfirm(); doToggle(habit, false); },
            });
            return;
        }

        // Future date → show confirm modal
        if (view === 'calendar' && calendarDate > todayISO()) {
            showConfirm({
                title: `Log "${habit.name}" for a future date?`,
                detail: `You're marking this complete for ${calendarDate}.`,
                confirmLabel: 'Log Anyway',
                onConfirm: () => { dismissConfirm(); doToggle(habit, true); },
            });
            return;
        }

        doToggle(habit, next);
    };

    const handleDelete = async (id: number) => {
        const habit = habits.find(h => h.id === id);
        closeModal();
        setHabits(prev => prev.filter(h => h.id !== id));
        try {
            await api.habits.remove(id);
            const displayName = habit?.encrypted ? 'Habit' : `"${habit?.name}"`;
            toast.success(`${displayName} ended`);
        } catch (err: unknown) {
            if (habit) setHabits(prev => [...prev, habit].sort((a, b) => a.id - b.id));
            toast.error(err instanceof Error ? err.message : "Delete failed");
        }
    };

    const handleCreate = async (data: {
        name: string; recurrence: string; positiveType: boolean;
        icon?: string; recurrenceEnd?: string | null; notes?: string; reminderTime?: string; reminderTz?: string;
    }) => {
        try {
            const newHabit = await api.habits.create(data);
            // Decrypt the new habit name for display if vault is unlocked
            const displayName = e2eeKey && isEncrypted(newHabit.name)
                ? await decryptRecursively(e2eeKey, newHabit.name).catch(() => newHabit.name)
                : newHabit.name;
            const processed = e2eeKey
                ? await decryptHabits([newHabit], e2eeKey)
                : maskLockedHabits([newHabit]);
            setHabits(prev => [...prev, processed[0]]);
            toast.success(`"${displayName}" added`);
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Failed to create habit");
        }
    };

    const handleUpdate = async (id: number, changes: Record<string, unknown>) => {
        try {
            const updated = await api.habits.update(id, changes);
            const processed = e2eeKey
                ? await decryptHabits([updated], e2eeKey)
                : maskLockedHabits([updated]);
            setHabits(prev => prev.map(h => h.id === id ? processed[0] : h));
            toast.success("Habit updated");
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Update failed");
        }
    };

    const openEdit = (habit: HabitType) => {
        if (habit.encrypted && !isUnlocked) {
            toast.error('Unlock vault to edit this encrypted habit');
            return;
        }
        setHabitToEdit(habit);
        setModalOpen(true);
    };

    const closeModal = () => {
        setModalOpen(false);
        setHabitToEdit(null);
    };

    const openCreate = () => {
        if (userInfo?.e2eeEnabled && !isUnlocked) {
            toast.error('Unlock vault before adding a new habit');
            setVaultModalOpen(true);
            return;
        }
        setHabitToEdit(null);
        setModalOpen(true);
    };

    const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const filteredHabits = normalizedQuery
        ? habits.filter(h =>
            h.name.toLowerCase().includes(normalizedQuery) ||
            (h.notes ?? '').toLowerCase().includes(normalizedQuery)
        )
        : habits;
    const effectiveViewDate = view === 'calendar' ? calendarDate : todayISO();
    const archivedHabits = filteredHabits.filter(h => {
        if (!h.recurrenceEnd) return false;
        const endDay = h.recurrenceEnd.split('T')[0];
        return endDay <= effectiveViewDate;
    });
    const archivedIds = new Set(archivedHabits.map(h => h.id));
    const activeHabits = filteredHabits.filter(h => !archivedIds.has(h.id));
    const incomplete = activeHabits.filter(h => !h.complete);
    const complete = activeHabits.filter(h => h.complete);
    const lazyLoadAllEnabled = view === 'all' && normalizedQuery === '';
    const visibleIncomplete = lazyLoadAllEnabled ? incomplete.slice(0, allVisibleCount) : incomplete;
    const visibleComplete = lazyLoadAllEnabled ? complete.slice(0, allVisibleCount) : complete;
    const hasMoreAllHabits = lazyLoadAllEnabled && (
        visibleIncomplete.length < incomplete.length ||
        visibleComplete.length < complete.length
    );

    useEffect(() => {
        if (!lazyLoadAllEnabled) return;
        setAllVisibleCount(ALL_TAB_PAGE_SIZE);
    }, [lazyLoadAllEnabled, habits.length]);

    useEffect(() => {
        if (!hasMoreAllHabits || !allLoadMoreRef.current) return;
        const node = allLoadMoreRef.current;
        const observer = new IntersectionObserver(
            entries => {
                const entry = entries[0];
                if (!entry?.isIntersecting) return;
                setAllVisibleCount(prev => prev + ALL_TAB_PAGE_SIZE);
            },
            { root: null, rootMargin: '200px 0px 200px 0px', threshold: 0.01 }
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [hasMoreAllHabits]);

    const views: { id: DashboardView; label: string }[] = [
        { id: 'daily', label: 'Daily' },
        { id: 'all', label: 'All' },
        { id: 'calendar', label: 'Calendar' },
        { id: 'streak', label: 'Streaks' },
        { id: 'achievements', label: 'Achievements' },
    ];

    const showE2EESetupPrompt = Boolean(
        userInfo?.e2eeSetupPrompt &&
        !userInfo?.e2eeEnabled &&
        !showWelcomeOverlay &&
        !userInfo?.showWelcome &&
        !showDailySparkOverlay
    );

    const handleDismissE2EEPrompt = () => {
        if (!userInfo) return;
        dispatch(setUserInfo({ ...userInfo, e2eeSetupPrompt: false }));
        setE2EEPassphrase('');
        setE2EEPassphraseConfirm('');
    };

    const handleEnableE2EEFromPrompt = async () => {
        if (!userInfo) return;
        if (e2eePassphrase.length < 8) {
            toast.error('Passphrase must be at least 8 characters');
            return;
        }
        if (e2eePassphrase !== e2eePassphraseConfirm) {
            toast.error('Passphrases do not match');
            return;
        }

        setE2EESetupLoading(true);
        try {
            const salt = generateSalt();
            const key = await deriveKey(e2eePassphrase, salt);
            const verifier = await makeVerifier(key);
            const allHabits = await api.habits.list('all');
            const encryptedHabits = await Promise.all(allHabits.map(async h => ({
                id: h.id,
                name: isEncrypted(h.name) ? h.name : await encrypt(key, h.name),
                notes: h.notes ? (isEncrypted(h.notes) ? h.notes : await encrypt(key, h.notes)) : h.notes,
            })));

            const enableRes = await api.e2ee.enable({ salt, verifier, habits: encryptedHabits });
            if (!enableRes.enabled) {
                throw new Error('E2EE was not persisted on the server');
            }
            await e2eeUnlock(key);
            dispatch(setUserInfo({ ...userInfo, e2eeEnabled: true, e2eeSetupPrompt: false }));
            setE2EEPassphrase('');
            setE2EEPassphraseConfirm('');
            toast.success('End-to-end encryption enabled');
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : 'Failed to enable E2EE');
        } finally {
            setE2EESetupLoading(false);
        }
    };

    return (
        <>
            {showE2EESetupPrompt && (
                <E2EEPromptOverlay>
                    <E2EEPromptCard>
                        <InstallTitle>Set Up End-to-End Encryption?</InstallTitle>
                        <InstallText>
                            Turn on account-wide E2EE to encrypt habit names and notes with a password-derived key that only your devices can derive.
                        </InstallText>
                        <InstallText style={{ marginTop: '0.45rem', color: '#f0a66a' }}>
                            Important: your passphrase cannot be recovered. If older data was encrypted with an unknown/old key, that data may remain unreadable.
                        </InstallText>
                        <E2EEPromptInput
                            type="password"
                            placeholder="Create E2EE passphrase (min 8 chars)"
                            value={e2eePassphrase}
                            onChange={e => setE2EEPassphrase(e.target.value)}
                            autoComplete="new-password"
                        />
                        <E2EEPromptInput
                            type="password"
                            placeholder="Confirm passphrase"
                            value={e2eePassphraseConfirm}
                            onChange={e => setE2EEPassphraseConfirm(e.target.value)}
                            autoComplete="new-password"
                        />
                        <E2EEPromptActions>
                            <ConfirmBtn
                                onClick={handleDismissE2EEPrompt}
                                disabled={e2eeSetupLoading}
                            >
                                Maybe Later
                            </ConfirmBtn>
                            <InstallBtn
                                onClick={() => void handleEnableE2EEFromPrompt()}
                                disabled={e2eeSetupLoading || e2eePassphrase.length < 8 || e2eePassphrase !== e2eePassphraseConfirm}
                            >
                                {e2eeSetupLoading ? 'Encrypting…' : 'Enable E2EE'}
                            </InstallBtn>
                        </E2EEPromptActions>
                    </E2EEPromptCard>
                </E2EEPromptOverlay>
            )}
            {userInfo?.e2eeEnabled && !isUnlocked && vaultModalOpen && (
                <VaultUnlockModal onClose={() => setVaultModalOpen(false)} />
            )}
            <Page>
                <PageHeader>
                    <PageTitle>
                        <h1 style={{ margin: 0, fontSize: "clamp(1.4rem, 4vw, 2rem)" }}>
                            {userInfo ? `Hey, ${userInfo.username}` : 'Dashboard'}
                        </h1>
                        <DayLabel>{date}</DayLabel>
                    </PageTitle>
                    <AddButton onClick={openCreate}>
                        + New Habit
                    </AddButton>
                </PageHeader>

                <ViewTabBar>
                    {views.map(v => (
                        <ViewTab
                            key={v.id}
                            $active={view === v.id}
                            $highlight={v.id === 'achievements' && highlightAchievementsTab}
                            onClick={() => {
                                if (view === v.id) return;
                                setLoading(true);
                                setView(v.id);
                            }}
                        >
                            {v.label}
                        </ViewTab>
                    ))}
                </ViewTabBar>

                <SearchWrap>
                    <SearchInput
                        type="text"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        placeholder="Search habits by name or notes..."
                        aria-label="Search habits by name or notes"
                        style={{ paddingRight: searchQuery ? '2.3rem' : undefined }}
                    />
                    {searchQuery && (
                        <SearchClearBtn
                            type="button"
                            aria-label="Clear search"
                            title="Clear search"
                            onClick={() => setSearchQuery('')}
                        >
                            ×
                        </SearchClearBtn>
                    )}
                </SearchWrap>

                {view === 'calendar' && (
                    <CalendarControls>
                        <CalendarInput
                            type="date"
                            value={calendarDate}
                            onChange={e => {
                                setLoading(true);
                                setCalendarDate(e.target.value);
                            }}
                        />
                        <CalendarResetBtn
                            type="button"
                            onClick={() => {
                                const today = todayISO();
                                const shouldRefetch = calendarDate !== today;
                                if (shouldRefetch) setLoading(true);
                                setSearchQuery('');
                                setCalendarDate(today);
                            }}
                        >
                            Reset All
                        </CalendarResetBtn>
                    </CalendarControls>
                )}

                {loading ? (
                    <LoadingDots>Loading your habits</LoadingDots>
                ) : (
                    <ContentArea key={contentKey}>
                        {view === 'streak' ? (
                            <StreakView
                                habits={filteredHabits}
                                onDaySelect={(dateValue: string, habitName: string) => {
                                    setLoading(true);
                                    setView('calendar');
                                    setCalendarDate(dateValue);
                                    setSearchQuery(habitName);
                                }}
                            />
                        ) : view === 'achievements' ? (
                            <AchievementsView
                                achievements={achievements}
                                getBadgeSrc={(key: string) => ACHIEVEMENT_BADGES[key] || BadgeFirstCompletion}
                            />
                        ) : filteredHabits.length === 0 ? (
                            <EmptyState>
                                <p style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>
                                    {normalizedQuery ? 'No habits match your search.' : 'No habits here.'}
                                </p>
                                {!normalizedQuery && (
                                    <p style={{ fontSize: "0.9rem" }}>Click <strong>+ New Habit</strong> to add one.</p>
                                )}
                            </EmptyState>
                        ) : (
                            <>
                                <HabitSection
                                    label={`To Do — ${incomplete.length}`}
                                    habits={visibleIncomplete}
                                    getLogo={getLogo}
                                    onToggleComplete={handleToggleComplete}
                                    onEdit={openEdit}
                                />
                                <HabitSection
                                    label={`Completed — ${complete.length}`}
                                    habits={visibleComplete}
                                    getLogo={getLogo}
                                    onToggleComplete={handleToggleComplete}
                                    onEdit={openEdit}
                                />
                                <HabitSection
                                    label={`Archived — ${archivedHabits.length}`}
                                    habits={archivedHabits}
                                    getLogo={getLogo}
                                    onToggleComplete={handleToggleComplete}
                                    onEdit={openEdit}
                                />
                                {hasMoreAllHabits && (
                                    <LazyLoadSentinel ref={allLoadMoreRef} aria-hidden="true" />
                                )}
                            </>
                        )}
                    </ContentArea>
                )}
            </Page>

            <HabitModal
                showModal={modalOpen}
                onClose={closeModal}
                onCreate={handleCreate}
                onUpdate={handleUpdate}
                onDelete={handleDelete}
                habitToEdit={habitToEdit}
            />

            {confirmState && (
                <ConfirmOverlay $closing={confirmClosing} onClick={dismissConfirm}>
                    <ConfirmBox $closing={confirmClosing} onClick={e => e.stopPropagation()}>
                        <ConfirmTitle>{confirmState.title}</ConfirmTitle>
                        {confirmState.detail && <ConfirmDetail>{confirmState.detail}</ConfirmDetail>}
                        <ConfirmActions>
                            <ConfirmBtn onClick={dismissConfirm}>Cancel</ConfirmBtn>
                            <ConfirmBtn
                                $danger={confirmState.danger}
                                $primary={!confirmState.danger}
                                onClick={confirmState.onConfirm}
                            >
                                {confirmState.confirmLabel}
                            </ConfirmBtn>
                        </ConfirmActions>
                    </ConfirmBox>
                </ConfirmOverlay>
            )}

            {achievementUnlockToast && (
                <UnlockToast>
                    <UnlockToastImg
                        src={ACHIEVEMENT_BADGES[achievementUnlockToast.key] || BadgeFirstCompletion}
                        alt={achievementUnlockToast.title}
                    />
                    <UnlockToastText>
                        Achievement unlocked: {achievementUnlockToast.title}
                    </UnlockToastText>
                </UnlockToast>
            )}

            {showWelcomeOverlay && userInfo && (
                <WelcomeOverlay onClick={() => { void dismissWelcomeOverlay(); }}>
                    <WelcomeCard onClick={e => e.stopPropagation()}>
                        <WelcomeImage src={WelcomeToStokely} alt="Welcome to Stokely mascot" />
                        <WelcomeBubble>
                            <WelcomeSpeaker>Kindling</WelcomeSpeaker>
                            <WelcomeSpeech>
                                "It&apos;s great to meet you, {userInfo.username}! I&apos;ll join you on your journey towards betterment. You can disable my 'Daily Sparks' within Settings. Let's start building!"
                            </WelcomeSpeech>
                        </WelcomeBubble>
                        <WelcomeActions>
                            <WelcomeDismissBtn type="button" onClick={() => { void dismissWelcomeOverlay(); }}>
                                Dismiss
                            </WelcomeDismissBtn>
                        </WelcomeActions>
                    </WelcomeCard>
                </WelcomeOverlay>
            )}

            {showDailySparkOverlay && !showWelcomeOverlay && userInfo && (
                <WelcomeOverlay onClick={dismissDailySparkOverlay}>
                    <WelcomeCard onClick={e => e.stopPropagation()}>
                        <DailySparkImage src={dailySparkImage} alt="Kindling daily spark" />
                        <WelcomeBubble>
                            <DailySparkTitle>Daily Spark</DailySparkTitle>
                            <WelcomeSpeaker>Kindling</WelcomeSpeaker>
                            <WelcomeSpeech>"{dailySparkMessage}"</WelcomeSpeech>
                        </WelcomeBubble>
                        <WelcomeActions>
                            <WelcomeDismissBtn type="button" onClick={dismissDailySparkOverlay}>
                                Dismiss
                            </WelcomeDismissBtn>
                        </WelcomeActions>
                    </WelcomeCard>
                </WelcomeOverlay>
            )}

            {showInstallPrompt && !showWelcomeOverlay && !showDailySparkOverlay && (
                <WelcomeOverlay onClick={dismissInstallPrompt}>
                    <WelcomeCard onClick={e => e.stopPropagation()}>
                        <WelcomeBubble>
                            <InstallTitle>Add Stokely to your home screen</InstallTitle>
                            {installPlatform === 'ios' ? (
                                <InstallText>
                                    In Safari, tap the Share button, then choose Add to Home Screen.
                                </InstallText>
                            ) : (
                                <InstallText>
                                    Install Stokely for a full-screen app experience and faster access.
                                </InstallText>
                            )}
                        </WelcomeBubble>
                        <InstallActions>
                            <WelcomeDismissBtn type="button" onClick={dismissInstallPrompt}>
                                Not now
                            </WelcomeDismissBtn>
                            {installPlatform === 'android' && (
                                <InstallBtn type="button" onClick={() => { void triggerAndroidInstall(); }}>
                                    Install
                                </InstallBtn>
                            )}
                        </InstallActions>
                    </WelcomeCard>
                </WelcomeOverlay>
            )}

            {showPasskeyPrompt && !showWelcomeOverlay && !showDailySparkOverlay && (
                <WelcomeOverlay onClick={() => dismissPasskeyPrompt(passkeyPromptDoNotShow)}>
                    <WelcomeCard onClick={e => e.stopPropagation()}>
                        <WelcomeBubble>
                            <InstallTitle>Sign in faster with a Passkey</InstallTitle>
                            <InstallText>
                                Use Face ID, fingerprint, or your device PIN instead of a password.
                                Passkeys sync to your other devices automatically.
                            </InstallText>
                            <InstallText style={{ marginTop: '0.5rem', color: '#aaa', fontSize: '0.82rem' }}>
                                You can add or remove passkeys any time from Settings.
                            </InstallText>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginTop: '0.75rem', color: '#bbb', fontSize: '0.82rem', cursor: 'pointer' }}>
                                <input
                                    type="checkbox"
                                    checked={passkeyPromptDoNotShow}
                                    onChange={e => setPasskeyPromptDoNotShow(e.target.checked)}
                                    style={{ accentColor: '#2dca8e' }}
                                />
                                Don't show me this again
                            </label>
                        </WelcomeBubble>
                        <InstallActions>
                            <WelcomeDismissBtn
                                type="button"
                                onClick={() => dismissPasskeyPrompt(passkeyPromptDoNotShow)}
                                disabled={passkeyRegistering}
                            >
                                Not now
                            </WelcomeDismissBtn>
                            <InstallBtn
                                type="button"
                                onClick={() => { void handlePasskeyPromptRegister(); }}
                                disabled={passkeyRegistering}
                            >
                                {passkeyRegistering ? 'Setting up…' : 'Add Passkey'}
                            </InstallBtn>
                        </InstallActions>
                    </WelcomeCard>
                </WelcomeOverlay>
            )}
        </>
    );
}
