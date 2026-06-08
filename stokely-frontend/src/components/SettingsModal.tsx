import { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api } from '../api/api';
import { clearUserInfo, setUserInfo } from '../redux/userSlice';
import type { RootState } from '../redux/store';
import type { PushSubscriptionDevice, UserSession, PasskeyInfo } from '../types/habit';
import { syncPushSubscriptionOnDevice } from '../utils/pushNotifications';
import { useE2EE } from '../context/E2EEContext';
import { generateSalt, deriveKey, makeVerifier, checkVerifier, encrypt, decryptRecursively, isEncrypted } from '../utils/e2ee';
import { registerPasskey, isWebAuthnAvailable, isPasskeySupported } from '../utils/passkey';
import './SettingsModal.css';

type Props = { onClose: () => void; initialSection?: 'e2ee' | 'passkeys' };

export default function SettingsModal({ onClose, initialSection }: Props) {
    const dispatch = useDispatch();
    const navigate = useNavigate();
    const userInfo = useSelector((state: RootState) => state.user.userInfo);

    // Change password
    const [currentPw, setCurrentPw] = useState('');
    const [newPw, setNewPw] = useState('');
    const [confirmPw, setConfirmPw] = useState('');
    const [pwLoading, setPwLoading] = useState(false);

    // Email update
    const [newEmail, setNewEmail] = useState('');
    const [emailLoading, setEmailLoading] = useState(false);
    const [emailSent, setEmailSent] = useState(false);
    const [removeEmailStep, setRemoveEmailStep] = useState(false);
    const [removeEmailLoading, setRemoveEmailLoading] = useState(false);

    // Delete account
    const [deleteStep, setDeleteStep] = useState(false);
    const [deleteAck, setDeleteAck] = useState(false);
    const [deletePw, setDeletePw] = useState('');
    const [deleteLoading, setDeleteLoading] = useState(false);

    const [sessions, setSessions] = useState<UserSession[]>([]);
    const [sessionsLoading, setSessionsLoading] = useState(false);
    const [logoutOthersLoading, setLogoutOthersLoading] = useState(false);

    // Passkeys
    const passkeySectionRef = useRef<HTMLElement>(null);
    const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
    const [passkeysLoading, setPasskeysLoading] = useState(false);
    const [passkeyRegistering, setPasskeyRegistering] = useState(false);
    const [passkeyName, setPasskeyName] = useState('');
    const [passkeyAddOpen, setPasskeyAddOpen] = useState(false);
    // null = still checking, true/false = resolved
    const [passkeySupported, setPasskeySupported] = useState<boolean | null>(isWebAuthnAvailable() ? null : false);

    const loadSessions = async () => {
        setSessionsLoading(true);
        try {
            setSessions(await api.sessions.list());
        } catch {
            toast.error('Failed to load sessions');
        } finally {
            setSessionsLoading(false);
        }
    };

    const handleDeleteSession = async (id: string) => {
        try {
            await api.sessions.logout(id);
            setSessions(prev => prev.filter(s => s.id !== id));
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : 'Failed to terminate session');
        }
    };

    const handleLogoutOthers = async () => {
        setLogoutOthersLoading(true);
        try {
            await api.sessions.logoutOthers();
            setSessions(prev => prev.filter(s => s.isCurrent));
            toast.success('All other sessions terminated');
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : 'Failed to terminate sessions');
        } finally {
            setLogoutOthersLoading(false);
        }
    };

    const [exportLoading, setExportLoading] = useState(false);
    const [dailySparkLoading, setDailySparkLoading] = useState(false);
    const [pushLoading, setPushLoading] = useState(false);
    const [pushSyncLoading, setPushSyncLoading] = useState(false);
    const [subscriptions, setSubscriptions] = useState<PushSubscriptionDevice[]>([]);

    // E2EE
    const e2eeSectionRef = useRef<HTMLElement>(null);
    const {
        key: e2eeKey,
        isUnlocked,
        unlock: e2eeUnlock,
        lock: e2eeLock,
    } = useE2EE();
    const [e2eePassphrase, setE2EEPassphrase] = useState('');
    const [e2eeConfirm, setE2EEConfirm] = useState('');
    const [e2eeLoading, setE2EELoading] = useState(false);
    const [e2eeShowEnable, setE2EEShowEnable] = useState(false);
    const [e2eeShowChange, setE2EEShowChange] = useState(false);
    const [e2eeCurrentPass, setE2EECurrentPass] = useState('');
    const [e2eeNewPass, setE2EENewPass] = useState('');
    const [e2eeNewConfirm, setE2EENewConfirm] = useState('');
    const [e2eeDisableStep, setE2EEDisableStep] = useState(false);
    const [e2eeUnlockPass, setE2EEUnlockPass] = useState('');

    useEffect(() => {
        if (initialSection === 'e2ee' && e2eeSectionRef.current) {
            e2eeSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        if (initialSection === 'passkeys' && passkeySectionRef.current) {
            passkeySectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }, [initialSection]);

    const loadPasskeys = async () => {
        setPasskeysLoading(true);
        try {
            setPasskeys(await api.passkeys.list());
        } catch {
            toast.error('Failed to load passkeys');
        } finally {
            setPasskeysLoading(false);
        }
    };

    const handleAddPasskey = async () => {
        if (!isWebAuthnAvailable()) {
            toast.error('Passkeys are not supported in this browser');
            return;
        }
        setPasskeyRegistering(true);
        try {
            const name = passkeyName.trim() || 'Passkey';
            await registerPasskey(name);
            toast.success('Passkey added');
            setPasskeyAddOpen(false);
            setPasskeyName('');
            dispatch(setUserInfo({ ...userInfo!, hasPasskeys: true }));
            await loadPasskeys();
        } catch (err: unknown) {
            if (err instanceof Error && err.name !== 'NotAllowedError') {
                toast.error(err.message || 'Failed to add passkey');
            }
        } finally {
            setPasskeyRegistering(false);
        }
    };

    const handleDeletePasskey = async (id: number) => {
        try {
            await api.passkeys.delete(id);
            const next = passkeys.filter(p => p.id !== id);
            setPasskeys(next);
            if (next.length === 0) {
                dispatch(setUserInfo({ ...userInfo!, hasPasskeys: false }));
            }
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : 'Failed to delete passkey');
        }
    };

    const loadSubscriptions = async () => {
        setPushLoading(true);
        try {
            const list = await api.push.listSubscriptions();
            setSubscriptions(list);
        } catch {
            toast.error('Failed to load notification devices');
        } finally {
            setPushLoading(false);
        }
    };

    const handleChangePassword = async () => {
        if (newPw !== confirmPw) { toast.error('Passwords do not match'); return; }
        setPwLoading(true);
        try {
            await api.auth.changePassword(currentPw, newPw);
            toast.success('Password updated');
            setCurrentPw(''); setNewPw(''); setConfirmPw('');
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : 'Failed to update password');
        } finally {
            setPwLoading(false);
        }
    };

    const handleExport = async () => {
        setExportLoading(true);
        try {
            const data = await api.user.exportData();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `stokely-export-${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
            toast.success('Export downloaded');
        } catch {
            toast.error('Export failed');
        } finally {
            setExportLoading(false);
        }
    };

    const handleDeleteAccount = async () => {
        setDeleteLoading(true);
        try {
            await api.user.deleteAccount(deletePw);
            dispatch(clearUserInfo());
            onClose();
            navigate('/');
            toast.success('Account deleted');
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : 'Deletion failed');
        } finally {
            setDeleteLoading(false);
        }
    };

    const handleRemoveEmail = async () => {
        setRemoveEmailLoading(true);
        try {
            await api.auth.removeEmail();
            dispatch(setUserInfo({ ...userInfo!, email: undefined, emailVerified: false }));
            setRemoveEmailStep(false);
            toast.success('Email removed from your account');
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : 'Failed to remove email');
        } finally {
            setRemoveEmailLoading(false);
        }
    };

    const handleSendVerifyEmail = async () => {
        if (!newEmail.trim()) return;
        setEmailLoading(true);
        try {
            await api.auth.sendVerifyEmail(newEmail.trim());
            setEmailSent(true);
            setNewEmail('');
            toast.success('Verification email sent — check your inbox');
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : 'Failed to send verification email');
        } finally {
            setEmailLoading(false);
        }
    };

    const handleDailySparkToggle = async (enabled: boolean) => {
        if (!userInfo) return;
        setDailySparkLoading(true);
        try {
            const res = await api.auth.setDailySparkEnabled(enabled);
            dispatch(setUserInfo({ ...userInfo, dailySparkEnabled: res.dailySparkEnabled }));
            toast.success(res.dailySparkEnabled ? 'Daily Spark enabled' : 'Daily Spark disabled');
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : 'Failed to update Daily Spark setting');
        } finally {
            setDailySparkLoading(false);
        }
    };

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [onClose]);

    useEffect(() => {
        void loadSubscriptions();
        void loadSessions();
        void loadPasskeys();
    }, []);

    useEffect(() => {
        if (passkeySupported !== null) return;
        void isPasskeySupported().then(setPasskeySupported);
    }, [passkeySupported]);

    const handleEnableOnThisDevice = async () => {
        setPushSyncLoading(true);
        try {
            const ok = await syncPushSubscriptionOnDevice({ requestPermission: true, forceRefresh: true });
            if (!ok) {
                toast.error('Notifications are blocked on this device');
                return;
            }
            toast.success('This device is now subscribed');
            await loadSubscriptions();
        } catch {
            toast.error('Could not enable notifications on this device');
        } finally {
            setPushSyncLoading(false);
        }
    };

    const handleToggleSubscription = async (id: number, enabled: boolean) => {
        try {
            await api.push.updateSubscription(id, enabled);
            setSubscriptions(prev => prev.map(s => s.id === id ? { ...s, enabled } : s));
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : 'Failed to update notification setting');
        }
    };

    const handleDeleteSubscription = async (id: number) => {
        try {
            await api.push.deleteSubscription(id);
            setSubscriptions(prev => prev.filter(s => s.id !== id));
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : 'Failed to remove device');
        }
    };

    const handleTestSubscription = async (id: number) => {
        try {
            const res = await api.push.testSubscription(id);
            toast.success(`Test push accepted (${res.statusCode})`);
            await loadSubscriptions();
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : 'Test notification failed');
            await loadSubscriptions();
        }
    };

    const handleE2EEEnable = async () => {
        if (!userInfo || e2eePassphrase !== e2eeConfirm) { toast.error('Passphrases do not match'); return; }
        if (e2eePassphrase.length < 8) { toast.error('Passphrase must be at least 8 characters'); return; }
        setE2EELoading(true);
        try {
            const salt = generateSalt();
            const key = await deriveKey(e2eePassphrase, salt);
            const verifier = await makeVerifier(key);
            const habits = await api.habits.list('all');
            const encryptedHabits = await Promise.all(habits.map(async h => ({
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
            setE2EEPassphrase(''); setE2EEConfirm(''); setE2EEShowEnable(false);
            toast.success('End-to-end encryption is now enabled for your account');
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : 'Failed to enable E2EE');
        } finally {
            setE2EELoading(false);
        }
    };

    const handleE2EEUnlock = async () => {
        if (!e2eeUnlockPass) return;
        setE2EELoading(true);
        try {
            const status = await api.e2ee.status();
            if (!status.enabled) { toast.error('E2EE vault is not configured'); return; }
            if (!status.salt || !status.verifier) { toast.error('Vault data incomplete — please re-enable E2EE'); return; }
            const key = await deriveKey(e2eeUnlockPass, status.salt);
            const ok = await checkVerifier(key, status.verifier);
            if (!ok) { toast.error('Incorrect passphrase'); return; }
            await e2eeUnlock(key);
            setE2EEUnlockPass('');
            toast.success('Vault unlocked');
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : 'Failed to unlock vault');
        } finally {
            setE2EELoading(false);
        }
    };

    const handleE2EEChangePassphrase = async () => {
        if (!userInfo || !e2eeKey) return;
        if (e2eeNewPass !== e2eeNewConfirm) { toast.error('New passphrases do not match'); return; }
        if (e2eeNewPass.length < 8) { toast.error('Passphrase must be at least 8 characters'); return; }
        setE2EELoading(true);
        try {
            const status = await api.e2ee.status();
            if (!status.salt || !status.verifier) { toast.error('Vault data incomplete'); return; }
            const currentKey = await deriveKey(e2eeCurrentPass, status.salt);
            const valid = await checkVerifier(currentKey, status.verifier);
            if (!valid) { toast.error('Current passphrase is incorrect'); return; }
            const newSalt = generateSalt();
            const newKey = await deriveKey(e2eeNewPass, newSalt);
            const newVerifier = await makeVerifier(newKey);
            const habits = await api.habits.list('all');
            const encryptedHabits = habits.filter(h => isEncrypted(h.name) || isEncrypted(h.notes));
            const decryptedHabits = await Promise.all(encryptedHabits.map(async h => ({
                id: h.id,
                name: isEncrypted(h.name) ? await decryptRecursively(e2eeKey, h.name) : h.name,
                notes: isEncrypted(h.notes) ? await decryptRecursively(e2eeKey, h.notes) : h.notes,
            })));
            const reencryptedHabits = await Promise.all(decryptedHabits.map(async h => ({
                id: h.id,
                name: await encrypt(newKey, h.name),
                notes: h.notes ? await encrypt(newKey, h.notes) : h.notes,
            })));
            await api.e2ee.changePassphrase({ salt: newSalt, verifier: newVerifier, habits: reencryptedHabits });
            await e2eeUnlock(newKey);
            setE2EECurrentPass(''); setE2EENewPass(''); setE2EENewConfirm(''); setE2EEShowChange(false);
            toast.success('Vault passphrase updated');
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : 'Failed to change passphrase');
        } finally {
            setE2EELoading(false);
        }
    };

    const handleE2EEDisable = async () => {
        if (!userInfo || !e2eeKey) return;
        setE2EELoading(true);
        try {
            const habits = await api.habits.list('all');
            const encryptedHabits = habits.filter(h => isEncrypted(h.name) || isEncrypted(h.notes));
            const decryptedHabits = await Promise.all(encryptedHabits.map(async h => ({
                id: h.id,
                name: isEncrypted(h.name) ? await decryptRecursively(e2eeKey, h.name) : h.name,
                notes: isEncrypted(h.notes) ? await decryptRecursively(e2eeKey, h.notes) : h.notes,
            })));
            await api.e2ee.disable(decryptedHabits);
            await e2eeLock();
            dispatch(setUserInfo({ ...userInfo, e2eeEnabled: false, e2eeSetupPrompt: false }));
            setE2EEDisableStep(false);
            toast.success('End-to-end encryption disabled');
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : 'Failed to disable E2EE');
        } finally {
            setE2EELoading(false);
        }
    };

    const renderSessionDevice = (ua: string): string => {
        if (/iphone/i.test(ua)) return 'iPhone';
        if (/ipad/i.test(ua)) return 'iPad';
        if (/android/i.test(ua)) return 'Android Device';
        if (/windows/i.test(ua)) return 'Windows PC';
        if (/macintosh|mac os x/i.test(ua)) return 'Mac';
        if (ua === '') return 'Unknown Device';
        return 'Browser';
    };

    const renderSubscriptionName = (s: PushSubscriptionDevice): string => {
        if (s.deviceLabel) return s.deviceLabel;
        if (/iphone/i.test(s.userAgent)) return 'iPhone';
        if (/ipad/i.test(s.userAgent)) return 'iPad';
        if (/android/i.test(s.userAgent)) return 'Android Device';
        if (/windows/i.test(s.userAgent)) return 'Windows PC';
        if (/macintosh|mac os x/i.test(s.userAgent)) return 'Mac';
        return 'Unknown Device';
    };

    return (
        <div className="settings-modal-overlay" onClick={onClose}>
            <div className="settings-modal-box" onClick={e => e.stopPropagation()}>
                <div className="settings-modal-header">
                    <h2>Settings</h2>
                    <button className="settings-close-btn" onClick={onClose}>✕</button>
                </div>

                {/* Change Password */}
                <section className="settings-section">
                    <h3 className="settings-section-title">Change Password</h3>
                    <input
                        type="password"
                        className="settings-input"
                        placeholder="Current password"
                        value={currentPw}
                        onChange={e => setCurrentPw(e.target.value)}
                        autoComplete="current-password"
                    />
                    <input
                        type="password"
                        className="settings-input"
                        placeholder="New password (min 8 characters)"
                        value={newPw}
                        onChange={e => setNewPw(e.target.value)}
                        autoComplete="new-password"
                    />
                    <input
                        type="password"
                        className="settings-input"
                        placeholder="Confirm new password"
                        value={confirmPw}
                        onChange={e => setConfirmPw(e.target.value)}
                        autoComplete="new-password"
                    />
                    <button
                        className="settings-btn settings-btn--primary"
                        onClick={handleChangePassword}
                        disabled={pwLoading || !currentPw || newPw.length < 8 || newPw !== confirmPw}
                    >
                        {pwLoading ? 'Updating…' : 'Update Password'}
                    </button>
                </section>

                {/* Passkeys */}
                <section className="settings-section" ref={passkeySectionRef}>
                    <h3 className="settings-section-title">Passkeys</h3>
                    <p className="settings-desc">
                        Sign in without a password using Face ID, Touch ID, or a hardware security key.
                    </p>
                    {passkeysLoading ? (
                        <p className="settings-desc">Loading passkeys…</p>
                    ) : passkeys.length > 0 ? (
                        <div className="settings-device-list">
                            {passkeys.map(pk => (
                                <div key={pk.id} className="settings-device-item">
                                    <div className="settings-device-meta">
                                        <strong>{pk.name}</strong>
                                        <span>Added: {new Date(pk.createdAt).toLocaleDateString()}</span>
                                        {pk.lastUsedAt && (
                                            <span>Last used: {new Date(pk.lastUsedAt).toLocaleDateString()}</span>
                                        )}
                                    </div>
                                    <div className="settings-device-actions">
                                        <button
                                            type="button"
                                            className="settings-btn settings-btn--secondary"
                                            onClick={() => void handleDeletePasskey(pk.id)}
                                        >
                                            Remove
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="settings-desc">No passkeys registered yet.</p>
                    )}
                    {passkeySupported === false ? (
                        <p className="settings-desc passkey-unsupported">
                            Passkeys are not supported in this browser.
                        </p>
                    ) : passkeyAddOpen ? (
                        <div className="passkey-add-form">
                            <input
                                type="text"
                                className="settings-input"
                                placeholder="Label (e.g. MacBook Touch ID)"
                                value={passkeyName}
                                onChange={e => setPasskeyName(e.target.value)}
                                maxLength={120}
                                autoFocus
                            />
                            <div className="passkey-add-actions">
                                <button
                                    type="button"
                                    className="settings-btn settings-btn--secondary"
                                    onClick={() => { setPasskeyAddOpen(false); setPasskeyName(''); }}
                                    disabled={passkeyRegistering}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    className="settings-btn settings-btn--primary"
                                    onClick={() => void handleAddPasskey()}
                                    disabled={passkeyRegistering}
                                >
                                    {passkeyRegistering ? 'Waiting for authenticator…' : 'Register Passkey'}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <button
                            type="button"
                            className="settings-btn settings-btn--primary"
                            onClick={() => setPasskeyAddOpen(true)}
                        >
                            Add Passkey
                        </button>
                    )}
                </section>

                {/* Email */}
                <section className="settings-section">
                    <h3 className="settings-section-title">
                        {userInfo?.email ? 'Update Email' : 'Add Email'}
                    </h3>
                    {userInfo?.email ? (
                        <p className="settings-desc">
                            Current: <strong style={{ color: '#ddd' }}>{userInfo.email}</strong>
                            {userInfo.emailVerified
                                ? <span className="settings-session-current" style={{ marginLeft: '0.5rem' }}>Verified</span>
                                : <span style={{ marginLeft: '0.5rem', fontSize: '0.72rem', color: '#f0a66a' }}>Unverified</span>}
                        </p>
                    ) : (
                        <p className="settings-desc">Add a verified email to enable password recovery.</p>
                    )}
                    {emailSent ? (
                        <p className="settings-desc" style={{ color: '#2dca8e' }}>
                            ✓ Check your inbox for a verification link.
                        </p>
                    ) : removeEmailStep ? (
                        <div className="delete-confirm-box">
                            <p className="delete-warning">
                                ⚠️ Without an email you <strong>cannot recover your account</strong> if you forget your password.
                            </p>
                            <div className="delete-actions">
                                <button
                                    className="settings-btn settings-btn--secondary"
                                    onClick={() => setRemoveEmailStep(false)}
                                >
                                    Cancel
                                </button>
                                <button
                                    className="settings-btn settings-btn--danger"
                                    onClick={() => void handleRemoveEmail()}
                                    disabled={removeEmailLoading}
                                >
                                    {removeEmailLoading ? 'Removing…' : 'Remove Email'}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <input
                                type="email"
                                className="settings-input"
                                placeholder={userInfo?.email ? 'New email address' : 'you@example.com'}
                                value={newEmail}
                                onChange={e => setNewEmail(e.target.value)}
                                autoComplete="email"
                            />
                            <button
                                className="settings-btn settings-btn--primary"
                                onClick={() => void handleSendVerifyEmail()}
                                disabled={emailLoading || !newEmail.trim()}
                            >
                                {emailLoading ? 'Sending…' : 'Send Verification Email'}
                            </button>
                            {userInfo?.email && (
                                <button
                                    className="settings-btn settings-btn--danger"
                                    style={{ marginTop: '0.5rem' }}
                                    onClick={() => setRemoveEmailStep(true)}
                                >
                                    Remove Email
                                </button>
                            )}
                        </>
                    )}
                </section>

                {/* Daily SPark */}
                <section className="settings-section">
                    <h3 className="settings-section-title">Daily Spark</h3>
                    <p className="settings-desc">Show a motivational Kindling message when you log in.</p>
                    <label className="settings-toggle-row">
                        <span>{userInfo?.dailySparkEnabled === false ? 'Disabled' : 'Enabled'}</span>
                        <input
                            type="checkbox"
                            checked={userInfo?.dailySparkEnabled !== false}
                            onChange={e => void handleDailySparkToggle(e.target.checked)}
                            disabled={dailySparkLoading}
                        />
                    </label>
                </section>

                {/* End-to-End Encryption */}
                <section className="settings-section" ref={e2eeSectionRef}>
                    <h3 className="settings-section-title">End-to-End Encryption</h3>
                    {!userInfo?.e2eeEnabled ? (
                        <>
                            <p className="settings-desc">Encrypts habit names and notes account-wide. The server never sees your data in plaintext.</p>
                            <p className="settings-desc" style={{ color: '#f0a66a' }}>⚠ Push notification reminders will show generic text when E2EE is enabled.</p>
                            <p className="settings-desc" style={{ color: '#f0a66a' }}>⚠ Your E2EE passphrase cannot be recovered. If old data was encrypted with an unknown/old key, that data may stay unreadable.</p>
                            {!e2eeShowEnable ? (
                                <button className="settings-btn settings-btn--primary" onClick={() => setE2EEShowEnable(true)}>
                                    Enable E2EE
                                </button>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                    <input
                                        type="password"
                                        className="settings-input"
                                        placeholder="Vault passphrase (min 8 chars)"
                                        value={e2eePassphrase}
                                        onChange={e => setE2EEPassphrase(e.target.value)}
                                        autoComplete="new-password"
                                    />
                                    <input
                                        type="password"
                                        className="settings-input"
                                        placeholder="Confirm passphrase"
                                        value={e2eeConfirm}
                                        onChange={e => setE2EEConfirm(e.target.value)}
                                        autoComplete="new-password"
                                    />
                                    <div className="delete-actions">
                                        <button className="settings-btn settings-btn--secondary" onClick={() => { setE2EEShowEnable(false); setE2EEPassphrase(''); setE2EEConfirm(''); }}>
                                            Cancel
                                        </button>
                                        <button
                                            className="settings-btn settings-btn--primary"
                                            onClick={() => void handleE2EEEnable()}
                                            disabled={e2eeLoading || e2eePassphrase.length < 8 || e2eePassphrase !== e2eeConfirm}
                                        >
                                            {e2eeLoading ? 'Setting up encryption…' : 'Enable'}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </>
                    ) : isUnlocked ? (
                        <>
                            <p className="settings-desc">
                                <span className="settings-session-current" style={{ marginRight: '0.5rem' }}>Active</span>
                                Habit names and notes are encrypted for your whole account.
                            </p>
                            {!e2eeShowChange ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                    <button className="settings-btn settings-btn--secondary" onClick={() => setE2EEShowChange(true)}>
                                        Change Passphrase
                                    </button>
                                    <button className="settings-btn settings-btn--secondary" onClick={() => void e2eeLock()}>
                                        Lock Vault
                                    </button>
                                    {!e2eeDisableStep ? (
                                        <button className="settings-btn settings-btn--danger" onClick={() => setE2EEDisableStep(true)}>
                                            Disable Encryption
                                        </button>
                                    ) : (
                                        <div className="delete-confirm-box">
                                            <p className="delete-warning">⚠️ This will decrypt your account data on the server. Are you sure?</p>
                                            <div className="delete-actions">
                                                <button className="settings-btn settings-btn--secondary" onClick={() => setE2EEDisableStep(false)}>Cancel</button>
                                                <button className="settings-btn settings-btn--danger" disabled={e2eeLoading} onClick={() => void handleE2EEDisable()}>
                                                    {e2eeLoading ? 'Disabling…' : 'Confirm Disable'}
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                    <input
                                        type="password"
                                        className="settings-input"
                                        placeholder="Current passphrase"
                                        value={e2eeCurrentPass}
                                        onChange={e => setE2EECurrentPass(e.target.value)}
                                        autoComplete="current-password"
                                    />
                                    <input
                                        type="password"
                                        className="settings-input"
                                        placeholder="New passphrase (min 8 chars)"
                                        value={e2eeNewPass}
                                        onChange={e => setE2EENewPass(e.target.value)}
                                        autoComplete="new-password"
                                    />
                                    <input
                                        type="password"
                                        className="settings-input"
                                        placeholder="Confirm new passphrase"
                                        value={e2eeNewConfirm}
                                        onChange={e => setE2EENewConfirm(e.target.value)}
                                        autoComplete="new-password"
                                    />
                                    <div className="delete-actions">
                                        <button className="settings-btn settings-btn--secondary" onClick={() => { setE2EEShowChange(false); setE2EECurrentPass(''); setE2EENewPass(''); setE2EENewConfirm(''); }}>
                                            Cancel
                                        </button>
                                        <button
                                            className="settings-btn settings-btn--primary"
                                            onClick={() => void handleE2EEChangePassphrase()}
                                            disabled={e2eeLoading || !e2eeCurrentPass || e2eeNewPass.length < 8 || e2eeNewPass !== e2eeNewConfirm}
                                        >
                                            {e2eeLoading ? 'Re-encrypting…' : 'Update Passphrase'}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </>
                    ) : (
                        <>
                            <p className="settings-desc">
                                <span style={{ color: '#f0a66a', marginRight: '0.5rem' }}>Vault is locked</span>
                                Enter your passphrase to manage E2EE settings.
                            </p>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                <input
                                    type="password"
                                    className="settings-input"
                                    placeholder="Vault passphrase"
                                    value={e2eeUnlockPass}
                                    onChange={e => setE2EEUnlockPass(e.target.value)}
                                    autoComplete="current-password"
                                />
                                <button
                                    className="settings-btn settings-btn--primary"
                                    onClick={() => void handleE2EEUnlock()}
                                    disabled={e2eeLoading || !e2eeUnlockPass}
                                >
                                    {e2eeLoading ? 'Unlocking…' : 'Unlock Vault'}
                                </button>
                            </div>
                        </>
                    )}
                </section>

                {/* Export Data */}
                <section className="settings-section">
                    <h3 className="settings-section-title">Export Your Data</h3>
                    <p className="settings-desc">Download all your habits and logs as a JSON file.</p>
                    <button
                        className="settings-btn settings-btn--secondary"
                        onClick={handleExport}
                        disabled={exportLoading}
                    >
                        {exportLoading ? 'Exporting…' : 'Download JSON'}
                    </button>
                </section>

                {/* Notifications by Device */}
                <section className="settings-section">
                    <h3 className="settings-section-title">Notifications by Device</h3>
                    <p className="settings-desc">Manage which logged-in devices can receive reminders.</p>
                    <button
                        className="settings-btn settings-btn--primary"
                        onClick={() => void handleEnableOnThisDevice()}
                        disabled={pushSyncLoading}
                    >
                        {pushSyncLoading ? 'Enabling…' : 'Enable on This Device'}
                    </button>
                    {pushLoading ? (
                        <p className="settings-desc">Loading devices…</p>
                    ) : subscriptions.length === 0 ? (
                        <p className="settings-desc">No devices subscribed yet.</p>
                    ) : (
                        <div className="settings-device-list">
                            {subscriptions.map(sub => (
                                <div key={sub.id} className="settings-device-item">
                                    <div className="settings-device-meta">
                                        <strong>{renderSubscriptionName(sub)}</strong>
                                        <span>
                                            {sub.lastSuccessAt
                                                ? `Last delivered: ${new Date(sub.lastSuccessAt).toLocaleString()}`
                                                : 'No successful deliveries yet'}
                                        </span>
                                        {sub.failureCount > 0 && (
                                            <span className="settings-device-warning">
                                                Failures: {sub.failureCount}
                                                {sub.lastFailureCode ? ` (last ${sub.lastFailureCode})` : ''}
                                            </span>
                                        )}
                                    </div>
                                    <div className="settings-device-actions">
                                        <label className="settings-toggle-inline">
                                            <input
                                                type="checkbox"
                                                checked={sub.enabled}
                                                onChange={e => void handleToggleSubscription(sub.id, e.target.checked)}
                                            />
                                            <span>{sub.enabled ? 'Enabled' : 'Disabled'}</span>
                                        </label>
                                        <button
                                            type="button"
                                            className="settings-btn settings-btn--secondary"
                                            onClick={() => void handleTestSubscription(sub.id)}
                                        >
                                            Send Test
                                        </button>
                                        <button
                                            type="button"
                                            className="settings-btn settings-btn--secondary"
                                            onClick={() => void handleDeleteSubscription(sub.id)}
                                        >
                                            Remove
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </section>



                {/* Active Sessions */}
                <section className="settings-section">
                    <h3 className="settings-section-title">Active Sessions</h3>
                    <p className="settings-desc">Devices currently logged into your account.</p>
                    {sessions.filter(s => !s.isCurrent).length > 1 && (
                        <button
                            className="settings-btn settings-btn--secondary"
                            onClick={() => void handleLogoutOthers()}
                            disabled={logoutOthersLoading}
                        >
                            {logoutOthersLoading ? 'Signing out…' : 'Sign Out All Other Devices'}
                        </button>
                    )}
                    {sessionsLoading ? (
                        <p className="settings-desc">Loading sessions…</p>
                    ) : sessions.length === 0 ? (
                        <p className="settings-desc">No active sessions found.</p>
                    ) : (
                        <div className="settings-device-list">
                            {sessions.map(s => (
                                <div key={s.id} className="settings-device-item">
                                    <div className="settings-device-meta">
                                        <strong>
                                            {renderSessionDevice(s.userAgent)}
                                            {s.isCurrent && <span className="settings-session-current">Current</span>}
                                        </strong>
                                        <span>Signed in: {new Date(s.createdAt).toLocaleString()}</span>
                                        <span>Last active: {new Date(s.lastSeenAt).toLocaleString()}</span>
                                    </div>
                                    {!s.isCurrent && (
                                        <div className="settings-device-actions">
                                            <button
                                                type="button"
                                                className="settings-btn settings-btn--secondary"
                                                onClick={() => void handleDeleteSession(s.id)}
                                            >
                                                Sign Out
                                            </button>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </section>

                {/* Delete Account */}
                <section className="settings-section settings-section--danger">
                    <h3 className="settings-section-title settings-section-title--danger">Delete Account</h3>
                    {!deleteStep ? (
                        <>
                            <p className="settings-desc">Permanently delete your account and all associated data. This cannot be undone.</p>
                            <button
                                className="settings-btn settings-btn--danger"
                                onClick={() => setDeleteStep(true)}
                            >
                                Delete Account
                            </button>
                        </>
                    ) : (
                        <div className="delete-confirm-box">
                            <p className="delete-warning">
                                ⚠️ <strong>This is irreversible.</strong> All your habits, logs, and account data will be permanently deleted.
                            </p>
                            <label className="delete-ack-label">
                                <input
                                    type="checkbox"
                                    checked={deleteAck}
                                    onChange={e => setDeleteAck(e.target.checked)}
                                />
                                I understand this cannot be undone
                            </label>
                            <input
                                type="password"
                                className="settings-input"
                                placeholder="Enter your password to confirm"
                                value={deletePw}
                                onChange={e => setDeletePw(e.target.value)}
                                autoComplete="current-password"
                            />
                            <div className="delete-actions">
                                <button
                                    className="settings-btn settings-btn--secondary"
                                    onClick={() => { setDeleteStep(false); setDeleteAck(false); setDeletePw(''); }}
                                >
                                    Cancel
                                </button>
                                <button
                                    className="settings-btn settings-btn--danger"
                                    disabled={!deleteAck || !deletePw || deleteLoading}
                                    onClick={handleDeleteAccount}
                                >
                                    {deleteLoading ? 'Deleting…' : 'Permanently Delete'}
                                </button>
                            </div>
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
}
