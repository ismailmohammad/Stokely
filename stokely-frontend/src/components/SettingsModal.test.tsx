import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsModal from "./SettingsModal";

const mockState = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  dispatchMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
  onCloseMock: vi.fn(),
  mockUserInfo: {
    id: "user-1",
    username: "kindling",
    dailySparkEnabled: true,
    hasPasskeys: false,
  } as Record<string, unknown>,
  webAuthnAvailable: true,
  isPasskeySupportedMock: vi.fn(),
  registerPasskeyMock: vi.fn(),
  apiMock: {
    sessions: {
      list: vi.fn(),
      logout: vi.fn(),
      logoutOthers: vi.fn(),
    },
    passkeys: {
      list: vi.fn(),
      delete: vi.fn(),
    },
    push: {
      listSubscriptions: vi.fn(),
      updateSubscription: vi.fn(),
      deleteSubscription: vi.fn(),
      testSubscription: vi.fn(),
    },
    auth: {
      changePassword: vi.fn(),
      removeEmail: vi.fn(),
      sendVerifyEmail: vi.fn(),
      setDailySparkEnabled: vi.fn(),
    },
    user: {
      exportData: vi.fn(),
      deleteAccount: vi.fn(),
    },
    e2ee: {
      status: vi.fn(),
      enable: vi.fn(),
      changePassphrase: vi.fn(),
      disable: vi.fn(),
    },
    habits: {
      list: vi.fn(),
    },
  },
}));

vi.mock("react-redux", () => ({
  useDispatch: () => mockState.dispatchMock,
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({ user: { userInfo: mockState.mockUserInfo } }),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => mockState.navigateMock,
}));

vi.mock("react-hot-toast", () => ({
  default: {
    success: (...args: unknown[]) => mockState.toastSuccessMock(...args),
    error: (...args: unknown[]) => mockState.toastErrorMock(...args),
  },
}));

vi.mock("../api/api", () => ({
  api: mockState.apiMock,
}));

vi.mock("../redux/userSlice", () => ({
  clearUserInfo: () => ({ type: "user/clearUserInfo" }),
  setUserInfo: (info: unknown) => ({ type: "user/setUserInfo", payload: info }),
}));

vi.mock("../context/E2EEContext", () => ({
  useE2EE: () => ({
    key: null,
    isUnlocked: false,
    unlock: vi.fn(),
    lock: vi.fn(),
  }),
}));

vi.mock("../utils/passkey", () => ({
  isWebAuthnAvailable: () => mockState.webAuthnAvailable,
  isPasskeySupported: () => mockState.isPasskeySupportedMock(),
  registerPasskey: (...args: unknown[]) => mockState.registerPasskeyMock(...args),
}));

vi.mock("../utils/pushNotifications", () => ({
  syncPushSubscriptionOnDevice: vi.fn(),
}));

describe("SettingsModal passkeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.mockUserInfo = {
      id: "user-1",
      username: "kindling",
      dailySparkEnabled: true,
      hasPasskeys: false,
    };
    mockState.webAuthnAvailable = true;
    mockState.isPasskeySupportedMock.mockResolvedValue(true);
    mockState.registerPasskeyMock.mockResolvedValue({ id: 2, name: "Work Laptop" });
    mockState.apiMock.sessions.list.mockResolvedValue([]);
    mockState.apiMock.push.listSubscriptions.mockResolvedValue([]);
    mockState.apiMock.passkeys.list.mockResolvedValue([]);
    mockState.apiMock.passkeys.delete.mockResolvedValue({});
  });

  it("loads and displays registered passkeys", async () => {
    mockState.apiMock.passkeys.list.mockResolvedValue([
      {
        id: 7,
        name: "MacBook Touch ID",
        createdAt: "2026-01-02T12:00:00Z",
        lastUsedAt: "2026-01-03T12:00:00Z",
      },
    ]);

    render(<SettingsModal onClose={mockState.onCloseMock} />);

    expect(await screen.findByText("MacBook Touch ID")).toBeInTheDocument();
    expect(screen.getByText(/Added:/)).toBeInTheDocument();
    expect(screen.getByText(/Last used:/)).toBeInTheDocument();
    expect(mockState.apiMock.passkeys.list).toHaveBeenCalledTimes(1);
  });

  it("shows unsupported browser copy instead of the add button", async () => {
    mockState.webAuthnAvailable = false;

    render(<SettingsModal onClose={mockState.onCloseMock} />);

    expect(await screen.findByText("No passkeys registered yet.")).toBeInTheDocument();
    expect(screen.getByText("Passkeys are not supported in this browser.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add passkey/i })).not.toBeInTheDocument();
    expect(mockState.isPasskeySupportedMock).not.toHaveBeenCalled();
  });

  it("registers a new passkey with a trimmed label and refreshes the list", async () => {
    mockState.apiMock.passkeys.list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 2,
          name: "Work Laptop",
          createdAt: "2026-01-04T12:00:00Z",
        },
      ]);

    render(<SettingsModal onClose={mockState.onCloseMock} />);

    await screen.findByText("No passkeys registered yet.");
    fireEvent.click(screen.getByRole("button", { name: /add passkey/i }));
    fireEvent.change(screen.getByPlaceholderText(/label/i), { target: { value: "  Work Laptop  " } });
    fireEvent.click(screen.getByRole("button", { name: /register passkey/i }));

    await waitFor(() => {
      expect(mockState.registerPasskeyMock).toHaveBeenCalledWith("Work Laptop");
      expect(mockState.toastSuccessMock).toHaveBeenCalledWith("Passkey added");
      expect(mockState.dispatchMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "user/setUserInfo",
          payload: expect.objectContaining({ hasPasskeys: true }),
        }),
      );
      expect(mockState.apiMock.passkeys.list).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText("Work Laptop")).toBeInTheDocument();
  });

  it("uses the default passkey label when the input is blank", async () => {
    render(<SettingsModal onClose={mockState.onCloseMock} />);

    await screen.findByText("No passkeys registered yet.");
    fireEvent.click(screen.getByRole("button", { name: /add passkey/i }));
    fireEvent.click(screen.getByRole("button", { name: /register passkey/i }));

    await waitFor(() => {
      expect(mockState.registerPasskeyMock).toHaveBeenCalledWith("Passkey");
    });
  });

  it("stays silent when the user cancels the authenticator prompt", async () => {
    const notAllowed = Object.assign(new Error("cancelled"), { name: "NotAllowedError" });
    mockState.registerPasskeyMock.mockRejectedValue(notAllowed);

    render(<SettingsModal onClose={mockState.onCloseMock} />);

    await screen.findByText("No passkeys registered yet.");
    fireEvent.click(screen.getByRole("button", { name: /add passkey/i }));
    fireEvent.click(screen.getByRole("button", { name: /register passkey/i }));

    await waitFor(() => {
      expect(mockState.registerPasskeyMock).toHaveBeenCalled();
    });
    expect(mockState.toastErrorMock).not.toHaveBeenCalled();
  });

  it("removes the last passkey and clears hasPasskeys", async () => {
    mockState.mockUserInfo = {
      ...mockState.mockUserInfo,
      hasPasskeys: true,
    };
    mockState.apiMock.passkeys.list.mockResolvedValue([
      {
        id: 7,
        name: "MacBook Touch ID",
        createdAt: "2026-01-02T12:00:00Z",
      },
    ]);

    render(<SettingsModal onClose={mockState.onCloseMock} />);

    expect(await screen.findByText("MacBook Touch ID")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));

    await waitFor(() => {
      expect(mockState.apiMock.passkeys.delete).toHaveBeenCalledWith(7);
      expect(screen.queryByText("MacBook Touch ID")).not.toBeInTheDocument();
      expect(mockState.dispatchMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "user/setUserInfo",
          payload: expect.objectContaining({ hasPasskeys: false }),
        }),
      );
    });
  });
});
