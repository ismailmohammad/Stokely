import React, { useState } from "react";
import "./LoginPage.css";
import { Link, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../../api/api";
import { useDispatch } from "react-redux";
import { setUserInfo } from "../../redux/userSlice";

const RegisterPage = () => {
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [loading, setLoading] = useState(false);

    const navigate = useNavigate();
    const dispatch = useDispatch();

    const handleRegister = async (e: React.FormEvent) => {
        e.preventDefault();
        if (password !== confirmPassword) {
            toast.error("Passwords do not match");
            return;
        }
        setLoading(true);
        try {
            const user = await api.auth.register(username, password, email || undefined);
            dispatch(setUserInfo(user));
            if (user.emailPending) {
                toast.success("Account created! Check your email to verify your address.", { duration: 6000 });
            } else {
                toast.success("Account created!");
            }
            navigate("/dashboard");
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Registration failed");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="auth-page">
            <div className="auth-card">
                <h1 className="auth-title">Create account</h1>
                <form onSubmit={handleRegister} className="auth-form">
                    <label>Username</label>
                    <input
                        type="text"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="Choose a username"
                        required
                        minLength={3}
                        maxLength={50}
                        autoComplete="username"
                    />
                    <label>
                        Email <span className="optional-label">(optional)</span>
                    </label>
                    <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@example.com"
                        autoComplete="email"
                    />
                    {!email && (
                        <p className="auth-warning">
                            ⚠ Without an email address, recovering your account if you forget your password won't be possible.
                        </p>
                    )}
                    <label>Password</label>
                    <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Min. 8 characters"
                        required
                        minLength={8}
                        autoComplete="new-password"
                    />
                    <label>Confirm Password</label>
                    <input
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Repeat your password"
                        required
                        minLength={8}
                        autoComplete="new-password"
                    />
                    <button className="auth-submit" type="submit" disabled={loading}>
                        {loading ? "Creating account…" : "Create account"}
                    </button>
                </form>
                <p className="auth-switch">
                    Already have an account? <Link to="/login">Log in</Link>
                </p>
            </div>
        </div>
    );
};

export default RegisterPage;
