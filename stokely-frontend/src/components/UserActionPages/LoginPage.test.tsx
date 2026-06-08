import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./LoginPage";

// -- mocks ---------------------------------------------------------------------

const mockState = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  dispatchMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
  loginMock: vi.fn(),
  passkeyLoginFinishMock: vi.fn(),
  authenticateWithPasskeyMock: vi.fn(),
  webAuthnAvailable: true,
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => mockState.navigateMock,
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
}));

vi.mock("react-redux", () => ({
  useDispatch: () => mockState.dispatchMock,
}));

vi.mock("../../api/api", () => ({
  api: {
    auth: {
      login: (...args: unknown[]) => mockState.loginMock(...args),
    },
    passkeys: {
      loginFinish: (...args: unknown[]) => mockState.passkeyLoginFinishMock(...args),
    },
  },
}));

vi.mock("react-hot-toast", () => ({
  default: {
    success: (...args: unknown[]) => mockState.toastSuccessMock(...args),
    error: (...args: unknown[]) => mockState.toastErrorMock(...args),
  },
}));

vi.mock("../../utils/passkey", () => ({
  isWebAuthnAvailable: () => mockState.webAuthnAvailable,
  authenticateWithPasskey: (...args: unknown[]) => mockState.authenticateWithPasskeyMock(...args),
}));

vi.mock("../../redux/userSlice", () => ({
  setUserInfo: (info: unknown) => ({ type: "user/setUserInfo", payload: info }),
}));

// -- tests ---------------------------------------------------------------------

describe("LoginPage - passkey button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.webAuthnAvailable = true;
  });

  it("shows the passkey button when WebAuthn is available", () => {
    mockState.webAuthnAvailable = true;
    render(<LoginPage />);
    expect(screen.getByRole("button", { name: /sign in with a passkey/i })).toBeInTheDocument();
  });

  it("does not show the passkey button when WebAuthn is unavailable", () => {
    mockState.webAuthnAvailable = false;
    render(<LoginPage />);
    expect(screen.queryByRole("button", { name: /sign in with a passkey/i })).not.toBeInTheDocument();
  });

  it("shows the 'or' divider only when the passkey button is visible", () => {
    mockState.webAuthnAvailable = true;
    const { container } = render(<LoginPage />);
    expect(container.querySelector(".auth-divider")).toBeInTheDocument();
  });

  it("hides the 'or' divider when passkey button is not shown", () => {
    mockState.webAuthnAvailable = false;
    const { container } = render(<LoginPage />);
    expect(container.querySelector(".auth-divider")).not.toBeInTheDocument();
  });

  it("navigates to dashboard and dispatches user on successful passkey login", async () => {
    const fakeUser = { id: "u1", username: "alice", hasPasskeys: true };
    mockState.authenticateWithPasskeyMock.mockResolvedValue({ id: "cred", rawId: "raw", type: "public-key" });
    mockState.passkeyLoginFinishMock.mockResolvedValue(fakeUser);

    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with a passkey/i }));

    await waitFor(() => {
      expect(mockState.dispatchMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "user/setUserInfo", payload: fakeUser }),
      );
      expect(mockState.toastSuccessMock).toHaveBeenCalledWith("Welcome back!");
      expect(mockState.navigateMock).toHaveBeenCalledWith("/dashboard");
    });
  });

  it("shows no toast for NotAllowedError (user dismissed the OS picker)", async () => {
    const notAllowed = Object.assign(new Error("dismissed"), { name: "NotAllowedError" });
    mockState.authenticateWithPasskeyMock.mockRejectedValue(notAllowed);

    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with a passkey/i }));

    await waitFor(() => {
      expect(mockState.authenticateWithPasskeyMock).toHaveBeenCalled();
    });
    expect(mockState.toastErrorMock).not.toHaveBeenCalled();
    expect(mockState.navigateMock).not.toHaveBeenCalled();
  });

  it("shows an error toast for unexpected passkey errors", async () => {
    mockState.authenticateWithPasskeyMock.mockRejectedValue(new Error("server error"));

    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with a passkey/i }));

    await waitFor(() => {
      expect(mockState.toastErrorMock).toHaveBeenCalledWith("server error");
    });
    expect(mockState.navigateMock).not.toHaveBeenCalled();
  });

  it("disables both buttons while a passkey login is in flight", async () => {
    let resolve!: (v: unknown) => void;
    mockState.authenticateWithPasskeyMock.mockReturnValue(new Promise(r => { resolve = r; }));

    render(<LoginPage />);
    const passkeyBtn = screen.getByRole("button", { name: /sign in with a passkey/i });
    fireEvent.click(passkeyBtn);

    await waitFor(() => {
      expect(passkeyBtn).toBeDisabled();
      expect(screen.getByRole("button", { name: /log in/i })).toBeDisabled();
    });

    await act(async () => {
      resolve({ id: "cred" });
    });
  });
});

describe("LoginPage - password form", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.webAuthnAvailable = false;
  });

  it("submits username and password, dispatches user and navigates", async () => {
    const fakeUser = { id: "u1", username: "alice" };
    mockState.loginMock.mockResolvedValue(fakeUser);

    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText("Username"), { target: { value: "alice" } });
    fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    await waitFor(() => {
      expect(mockState.loginMock).toHaveBeenCalledWith("alice", "password123");
      expect(mockState.dispatchMock).toHaveBeenCalled();
      expect(mockState.navigateMock).toHaveBeenCalledWith("/dashboard");
    });
  });

  it("shows an error toast when the password login API fails", async () => {
    mockState.loginMock.mockRejectedValue(new Error("Invalid username or password"));

    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText("Username"), { target: { value: "alice" } });
    fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: "wrongpass" } });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    await waitFor(() => {
      expect(mockState.toastErrorMock).toHaveBeenCalledWith("Invalid username or password");
    });
    expect(mockState.navigateMock).not.toHaveBeenCalled();
  });
});
