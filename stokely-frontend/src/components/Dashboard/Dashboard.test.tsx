import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Dashboard from "./Dashboard";

const mockState = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  dispatchMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  apiMock: {
    auth: {
      me: vi.fn(),
      markWelcomeSeen: vi.fn(),
    },
    habits: {
      list: vi.fn(),
      getAchievements: vi.fn(),
      logComplete: vi.fn(),
      logUncomplete: vi.fn(),
      remove: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    e2ee: {
      enable: vi.fn(),
    },
    passkeys: {
      registerBegin: vi.fn(),
      registerFinish: vi.fn(),
    },
  },
  mockUserInfo: null as Record<string, unknown> | null,
  mockE2EE: {
    key: null as CryptoKey | null,
    isUnlocked: false,
    unlock: async (_key: CryptoKey) => {},
  },
  registerPasskeyMock: vi.fn(),
  webAuthnAvailable: true,
}));

vi.mock("../../api/api", () => ({
  api: mockState.apiMock,
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => mockState.navigateMock,
}));

vi.mock("react-redux", () => ({
  useDispatch: () => mockState.dispatchMock,
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({ user: { userInfo: mockState.mockUserInfo } }),
}));

vi.mock("../../context/E2EEContext", () => ({
  useE2EE: () => mockState.mockE2EE,
}));

vi.mock("react-hot-toast", () => ({
  default: {
    error: (...args: unknown[]) => mockState.toastErrorMock(...args),
    success: (...args: unknown[]) => mockState.toastSuccessMock(...args),
  },
}));

vi.mock("../../utils/passkey", () => ({
  isWebAuthnAvailable: () => mockState.webAuthnAvailable,
  registerPasskey: (...args: unknown[]) => mockState.registerPasskeyMock(...args),
}));

vi.mock("./NewHabitModal", () => ({
  default: ({ showModal }: { showModal: boolean }) => (
    <div data-testid="new-habit-modal">{showModal ? "open" : "closed"}</div>
  ),
}));

vi.mock("../VaultUnlockModal", () => ({
  default: () => <div data-testid="vault-unlock-modal">vault unlock</div>,
}));

vi.mock("./Habit", () => ({
  default: () => <div />,
}));

vi.mock("./StreakView", () => ({
  default: () => <div />,
}));

vi.mock("./AchievementsView", () => ({
  default: () => <div />,
}));

describe("Dashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockState.mockUserInfo = {
      id: "user-1",
      username: "kindling",
      e2eeEnabled: true,
      e2eeSetupPrompt: false,
      showWelcome: false,
      dailySparkEnabled: true,
      hasPasskeys: false,
    };
    mockState.webAuthnAvailable = true;
    mockState.mockE2EE = {
      key: null,
      isUnlocked: false,
      unlock: async () => {},
    };

    mockState.apiMock.auth.me.mockResolvedValue(mockState.mockUserInfo);
    mockState.apiMock.auth.markWelcomeSeen.mockResolvedValue(undefined);
    mockState.apiMock.habits.list.mockResolvedValue([]);
    mockState.apiMock.habits.getAchievements.mockResolvedValue([]);
    mockState.apiMock.habits.logComplete.mockResolvedValue(undefined);
    mockState.apiMock.habits.logUncomplete.mockResolvedValue(undefined);
    mockState.apiMock.habits.remove.mockResolvedValue(undefined);
    mockState.apiMock.habits.create.mockResolvedValue(undefined);
    mockState.apiMock.habits.update.mockResolvedValue(undefined);
    mockState.apiMock.e2ee.enable.mockResolvedValue({ enabled: true, message: "ok" });

    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it("blocks new habit creation when e2ee is enabled and vault is locked", async () => {
    render(<Dashboard />);

    await screen.findByRole("button", { name: /\+ new habit/i });
    expect(screen.getByTestId("new-habit-modal")).toHaveTextContent("closed");

    fireEvent.click(screen.getByRole("button", { name: /\+ new habit/i }));

    await waitFor(() => {
      expect(mockState.toastErrorMock).toHaveBeenCalledWith("Unlock vault before adding a new habit");
      expect(screen.getByTestId("vault-unlock-modal")).toBeInTheDocument();
    });
    expect(screen.getByTestId("new-habit-modal")).toHaveTextContent("closed");
  });
});

// Flush all pending Promise microtasks so React state updates from mocked async
// API calls settle before we advance fake timers.
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Dashboard - passkey prompt", () => {
  const SPARK_TIMEOUT = 4000;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockState.mockUserInfo = {
      id: "user-2",
      username: "tester",
      e2eeEnabled: false,
      e2eeSetupPrompt: false,
      showWelcome: false,
      dailySparkEnabled: true,
      hasPasskeys: false,
    };
    mockState.webAuthnAvailable = true;
    mockState.registerPasskeyMock.mockResolvedValue({ id: 1, name: "Passkey" });

    mockState.apiMock.auth.me.mockResolvedValue(mockState.mockUserInfo);
    mockState.apiMock.auth.markWelcomeSeen.mockResolvedValue(undefined);
    mockState.apiMock.habits.list.mockResolvedValue([]);
    mockState.apiMock.habits.getAchievements.mockResolvedValue([]);

    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false, media: query, onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(),
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    // Clear any stale dismissed flag from other tests
    try { localStorage.removeItem("stokely_passkey_prompt_dismissed_v1_user-2"); } catch { /* ignore */ }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function renderAndAdvancePastSpark() {
    render(<Dashboard />);
    // Flush API call microtasks so effects that depend on data settle.
    await flushMicrotasks();
    // Advance past the daily-spark auto-dismiss timer.
    await act(async () => { vi.advanceTimersByTime(SPARK_TIMEOUT + 100); });
    // Flush any state updates triggered by the timer (sparkJustCompleted, etc.).
    await flushMicrotasks();
  }

  it("does not show the passkey prompt immediately on render", async () => {
    render(<Dashboard />);
    await flushMicrotasks();
    expect(screen.queryByText(/sign in faster with a passkey/i)).not.toBeInTheDocument();
  });

  it("shows the passkey prompt after the daily spark auto-dismisses (hasPasskeys false)", async () => {
    await renderAndAdvancePastSpark();
    expect(screen.getByText(/sign in faster with a passkey/i)).toBeInTheDocument();
  });

  it("does not show the passkey prompt when hasPasskeys is true", async () => {
    mockState.mockUserInfo = { ...mockState.mockUserInfo, hasPasskeys: true };
    mockState.apiMock.auth.me.mockResolvedValue(mockState.mockUserInfo);
    await renderAndAdvancePastSpark();
    expect(screen.queryByText(/sign in faster with a passkey/i)).not.toBeInTheDocument();
  });

  it("does not show the passkey prompt when hasPasskeys is undefined (unknown)", async () => {
    const { hasPasskeys: _, ...noHasPasskeys } = mockState.mockUserInfo as Record<string, unknown>;
    mockState.mockUserInfo = noHasPasskeys;
    mockState.apiMock.auth.me.mockResolvedValue(mockState.mockUserInfo);
    await renderAndAdvancePastSpark();
    expect(screen.queryByText(/sign in faster with a passkey/i)).not.toBeInTheDocument();
  });

  it("does not show the passkey prompt when WebAuthn is unavailable", async () => {
    mockState.webAuthnAvailable = false;
    await renderAndAdvancePastSpark();
    expect(screen.queryByText(/sign in faster with a passkey/i)).not.toBeInTheDocument();
  });

  it("does not show the passkey prompt when the dismissed flag is in localStorage", async () => {
    try { localStorage.setItem("stokely_passkey_prompt_dismissed_v1_user-2", "1"); } catch { /* ignore */ }

    await renderAndAdvancePastSpark();
    expect(screen.queryByText(/sign in faster with a passkey/i)).not.toBeInTheDocument();
    try { localStorage.removeItem("stokely_passkey_prompt_dismissed_v1_user-2"); } catch { /* ignore */ }
  });

  it("prompt includes a label input field", async () => {
    await renderAndAdvancePastSpark();
    expect(screen.getByPlaceholderText(/label.*optional/i)).toBeInTheDocument();
  });

  it("prompt includes a 'Don't show me this again' checkbox", async () => {
    await renderAndAdvancePastSpark();
    expect(screen.getByLabelText(/don't show me this again/i)).toBeInTheDocument();
  });

  it("sets localStorage dismissed flag when 'Not now' is clicked with checkbox checked", async () => {
    await renderAndAdvancePastSpark();
    expect(screen.getByText(/sign in faster with a passkey/i)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/don't show me this again/i));
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));

    await flushMicrotasks();
    expect(screen.queryByText(/sign in faster with a passkey/i)).not.toBeInTheDocument();
    expect(localStorage.getItem("stokely_passkey_prompt_dismissed_v1_user-2")).toBe("1");
    try { localStorage.removeItem("stokely_passkey_prompt_dismissed_v1_user-2"); } catch { /* ignore */ }
  });

  it("registers with the entered label and updates hasPasskeys", async () => {
    await renderAndAdvancePastSpark();
    expect(screen.getByText(/sign in faster with a passkey/i)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/label/i), { target: { value: "  Phone Passkey  " } });
    fireEvent.click(screen.getByRole("button", { name: /add passkey/i }));
    await flushMicrotasks();

    expect(mockState.registerPasskeyMock).toHaveBeenCalledWith("Phone Passkey");
    expect(mockState.toastSuccessMock).toHaveBeenCalledWith(
      expect.stringContaining("Passkey added"),
    );
    expect(mockState.dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "user/setUserInfo",
        payload: expect.objectContaining({ hasPasskeys: true }),
      }),
    );
    expect(screen.queryByText(/sign in faster with a passkey/i)).not.toBeInTheDocument();
  });
});
