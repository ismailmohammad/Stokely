import React, { useEffect, useState } from "react";
import "./LoginPage.css";
import { Link, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../../api/api";
import { useDispatch } from "react-redux";
import { setUserInfo } from "../../redux/userSlice";
import { authenticateWithPasskey, isWebAuthnAvailable } from "../../utils/passkey";

const LoginPage = () => {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [passkeyLoading, setPasskeyLoading] = useState(false);
    const [showPasskeyBtn, setShowPasskeyBtn] = useState(false);

    const navigate = useNavigate();
    const dispatch = useDispatch();

    // Async check so we don't show the button on unsupported browsers
    useEffect(() => {
        setShowPasskeyBtn(isWebAuthnAvailable());
    }, []);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        try {
            const user = await api.auth.login(username, password);
            dispatch(setUserInfo(user));
            toast.success("Welcome back!");
            navigate("/dashboard");
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Login failed");
        } finally {
            setLoading(false);
        }
    };

    const handlePasskeyLogin = async () => {
        setPasskeyLoading(true);
        try {
            const assertion = await authenticateWithPasskey();
            const user = await api.passkeys.loginFinish(assertion);
            dispatch(setUserInfo(user));
            toast.success("Welcome back!");
            navigate("/dashboard");
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'NotAllowedError') {
                // User dismissed the passkey picker — stay silent
                return;
            }
            toast.error(err instanceof Error ? err.message : "Passkey sign-in failed");
        } finally {
            setPasskeyLoading(false);
        }
    };

    const busy = loading || passkeyLoading;

    return (
        <div className="auth-page">
            <div className="auth-card">
                <h1 className="auth-title">Log in</h1>

                {showPasskeyBtn && (
                    <>
                        <button
                            type="button"
                            className="passkey-btn"
                            onClick={() => { void handlePasskeyLogin(); }}
                            disabled={busy}
                        >
                            <PasskeyIcon />
                            {passkeyLoading ? "Waiting for passkey…" : "Sign in with a passkey"}
                        </button>
                        <div className="auth-divider">
                            <span>or</span>
                        </div>
                    </>
                )}

                <form onSubmit={handleLogin} className="auth-form">
                    <label>Username</label>
                    <input
                        type="text"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="Username"
                        required
                        autoComplete="username"
                    />
                    <label>Password</label>
                    <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        required
                        minLength={8}
                        autoComplete="current-password"
                    />
                    <Link to="/forgot-password" className="forgot-password">Forgot password?</Link>
                    <button className="auth-submit" type="submit" disabled={busy}>
                        {loading ? "Logging in…" : "Log in"}
                    </button>
                </form>
                <p className="auth-switch">
                    Don't have an account? <Link to="/register">Get started</Link>
                </p>
            </div>
        </div>
    );
};

function PasskeyIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
            <circle cx="8" cy="8" r="4" stroke="currentColor" strokeWidth="2" />
            <path d="M2 20c0-3.314 2.686-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M15 13l1.5 1.5L20 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <rect x="13" y="10" width="9" height="7" rx="2" stroke="currentColor" strokeWidth="2" />
        </svg>
    );
}

export default LoginPage;
