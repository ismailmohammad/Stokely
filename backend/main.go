package main

import (
	"context"
	"encoding/base64"
	"errors"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-contrib/sessions"
	"github.com/gin-contrib/sessions/cookie"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	gormpg "gorm.io/driver/postgres"
	"gorm.io/gorm"
)

var db *gorm.DB
var sessionCookieDomain string
var sessionCookieSecure bool
var sessionCookieSameSite http.SameSite
var sessionMaxAgeSeconds = 86400 * 7

func main() {
	var err error

	dsn := getEnv("DB_DSN", "")
	if dsn == "" {
		log.Fatal("DB_DSN environment variable is required")
	}

	pgxCfg, err := pgx.ParseConfig(sanitizeDSN(dsn))
	if err != nil {
		log.Fatal("Failed to parse DB_DSN:", err)
	}
	// Force IPv4 — avoids unreachable IPv6 routes in Docker/WSL2 environments.
	// Both LookupFunc and DialFunc must be overridden: pgx resolves the hostname
	// before calling DialFunc, so we filter AAAA records at the lookup stage.
	pgxCfg.LookupFunc = func(ctx context.Context, host string) ([]string, error) {
		addrs, err := net.DefaultResolver.LookupHost(ctx, host)
		if err != nil {
			return nil, err
		}
		var ipv4 []string
		for _, addr := range addrs {
			if ip := net.ParseIP(addr); ip != nil && ip.To4() != nil {
				ipv4 = append(ipv4, addr)
			}
		}
		if len(ipv4) > 0 {
			return ipv4, nil
		}
		return addrs, nil // fallback if no IPv4 found
	}
	pgxCfg.DialFunc = func(ctx context.Context, network, addr string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp4", addr)
	}
	sqlDB := stdlib.OpenDB(*pgxCfg)

	db, err = gorm.Open(gormpg.New(gormpg.Config{Conn: sqlDB}), &gorm.Config{})
	if err != nil {
		log.Fatal("Failed to connect to database:", err)
	}

	if err := db.Exec("CREATE EXTENSION IF NOT EXISTS pgcrypto").Error; err != nil {
		log.Fatal("Failed to ensure pgcrypto extension:", err)
	}

	enforceUUIDUserIDSchema()

	if err := db.AutoMigrate(&User{}, &Habit{}, &HabitLog{}, &PushSubscription{}, &StreakFreeze{}, &UserSession{}, &EmailToken{}, &Passkey{}); err != nil {
		log.Fatal("Failed to run schema migration:", err)
	}
	// Safety net: ensure E2EE columns exist even if AutoMigrate missed them on existing tables.
	if err := db.Exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS e2ee_enabled boolean NOT NULL DEFAULT false`).Error; err != nil {
		log.Fatal("Failed to ensure users.e2ee_enabled:", err)
	}
	if err := db.Exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS e2ee_prompt_pending boolean NOT NULL DEFAULT true`).Error; err != nil {
		log.Fatal("Failed to ensure users.e2ee_prompt_pending:", err)
	}
	if err := db.Exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS e2ee_salt varchar(64) NOT NULL DEFAULT ''`).Error; err != nil {
		log.Fatal("Failed to ensure users.e2ee_salt:", err)
	}
	if err := db.Exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS e2ee_verifier varchar(512) NOT NULL DEFAULT ''`).Error; err != nil {
		log.Fatal("Failed to ensure users.e2ee_verifier:", err)
	}
	if err := db.Exec(`ALTER TABLE habits ADD COLUMN IF NOT EXISTS reminder_tz varchar(64) NOT NULL DEFAULT ''`).Error; err != nil {
		log.Fatal("Failed to ensure habits.reminder_tz:", err)
	}
	// Legacy bridge: if earlier migrations created e2_ee_* columns, copy values into canonical e2ee_* columns.
	if err := db.Exec(`
	DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_name = 'users' AND column_name = 'e2_ee_enabled'
	) THEN
		EXECUTE 'UPDATE users SET e2ee_enabled = (COALESCE(e2ee_enabled, false) OR COALESCE(e2_ee_enabled, false))';
	END IF;

	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_name = 'users' AND column_name = 'e2_ee_prompt_pending'
	) THEN
		EXECUTE 'UPDATE users SET e2ee_prompt_pending = (COALESCE(e2ee_prompt_pending, true) AND COALESCE(e2_ee_prompt_pending, true))';
	END IF;

	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_name = 'users' AND column_name = 'e2_ee_salt'
	) THEN
		EXECUTE $sql$UPDATE users SET e2ee_salt = COALESCE(NULLIF(e2ee_salt, ''), NULLIF(e2_ee_salt, ''), '')$sql$;
	END IF;

	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_name = 'users' AND column_name = 'e2_ee_verifier'
	) THEN
		EXECUTE $sql$UPDATE users SET e2ee_verifier = COALESCE(NULLIF(e2ee_verifier, ''), NULLIF(e2_ee_verifier, ''), '')$sql$;
	END IF;
END $$;
`).Error; err != nil {
		log.Fatal("Failed to backfill legacy E2EE columns:", err)
	}
	// Trust emails that existed before the verification system was added.
	if err := db.Exec("UPDATE users SET email_verified = true WHERE email IS NOT NULL AND email_verified = false").Error; err != nil {
		log.Fatal("Failed to backfill email verification state:", err)
	}
	// Privacy minimization: scrub previously stored raw session IP/user-agent and push user-agent metadata.
	if err := db.Exec("UPDATE user_sessions SET user_agent = '', ip_address = '' WHERE user_agent <> '' OR ip_address <> ''").Error; err != nil {
		log.Fatal("Failed to scrub legacy session metadata:", err)
	}
	if err := db.Exec("UPDATE push_subscriptions SET user_agent = '' WHERE user_agent <> ''").Error; err != nil {
		log.Fatal("Failed to scrub legacy push metadata:", err)
	}
	seedInitialStreakFreezes()
	initWebAuthn()

	router := gin.Default()
	// Trust only private RFC1918 ranges — the backend is reachable only from
	// Docker-internal containers (nginx → backend), never directly from the internet.
	if err := router.SetTrustedProxies([]string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"}); err != nil {
		log.Fatal("Failed to configure trusted proxies:", err)
	}

	allowedOrigins := []string{}
	for _, origin := range strings.Split(getEnv("FRONTEND_ORIGIN", ""), ",") {
		trimmed := strings.TrimSpace(origin)
		if trimmed == "" {
			continue
		}
		allowedOrigins = append(allowedOrigins, trimmed)
	}
	if len(allowedOrigins) == 0 {
		log.Fatal("FRONTEND_ORIGIN environment variable is required")
	}
	router.Use(cors.New(cors.Config{
		AllowOrigins:     allowedOrigins,
		AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "X-CSRF-Token"},
		AllowCredentials: true,
	}))

	secret := getEnv("SESSION_SECRET", "")
	if secret == "" {
		log.Fatal("SESSION_SECRET environment variable is required")
	}
	if len(secret) < 32 {
		log.Fatal("SESSION_SECRET must be at least 32 characters")
	}

	store := buildSessionStore(secret)
	sessionCookieSameSite = parseSameSite(getEnv("COOKIE_SAMESITE", "lax"))
	sessionCookieSecure = getEnv("COOKIE_SECURE", "") == "true"
	sessionCookieDomain = getEnv("COOKIE_DOMAIN", "")
	if strings.EqualFold(getEnv("GIN_MODE", ""), "release") && !sessionCookieSecure {
		log.Fatal("COOKIE_SECURE must be true when GIN_MODE=release")
	}
	if sessionCookieSameSite == http.SameSiteNoneMode && !sessionCookieSecure {
		log.Fatal("COOKIE_SAMESITE=none requires COOKIE_SECURE=true")
	}

	sessionName := "stokely-session"
	if sessionCookieSecure && sessionCookieDomain == "" {
		// __Host- cookies are host-only, Secure, Path=/ and avoid domain-scope ambiguity.
		sessionName = "__Host-stokely-session"
	}
	store.Options(sessions.Options{
		Path:     "/",
		Domain:   sessionCookieDomain,
		MaxAge:   sessionMaxAgeSeconds,
		HttpOnly: true,
		Secure:   sessionCookieSecure,
		SameSite: sessionCookieSameSite,
	})
	router.Use(sessions.Sessions(sessionName, store))

	api := router.Group("/api")
	{
		auth := api.Group("/auth")
		{
			auth.POST("/register", handleRegister)
			auth.POST("/login", handleLogin)
			auth.POST("/logout", requireAuth, requireCSRF, handleLogout)
			auth.GET("/me", requireAuth, handleMe)
			auth.PUT("/password", requireAuth, requireCSRF, handleChangePassword)
			auth.POST("/welcome-seen", requireAuth, requireCSRF, handleWelcomeSeen)
			auth.PUT("/daily-spark", requireAuth, requireCSRF, handleDailySparkPreference)
			auth.POST("/email/verify", requireAuth, requireCSRF, handleSendVerificationEmail)
			auth.GET("/email/verify", handleVerifyEmail)
			auth.DELETE("/email", requireAuth, requireCSRF, handleRemoveEmail)
			auth.POST("/password/forgot", handleForgotPassword)
			auth.POST("/password/reset", handleResetPassword)
			auth.POST("/passkey/begin", handlePasskeyLoginBegin)
			auth.POST("/passkey/finish", handlePasskeyLoginFinish)
		}

		habits := api.Group("/habits")
		habits.Use(requireAuth)
		{
			habits.GET("", getHabits)
			habits.GET("/achievements", getAchievements)
			habits.POST("", requireCSRF, createHabit)
			habits.PUT("/:id", requireCSRF, updateHabit)
			habits.DELETE("/:id", requireCSRF, deleteHabit)
			habits.POST("/:id/log", requireCSRF, createHabitLog)
			habits.DELETE("/:id/log", requireCSRF, deleteHabitLog)
			habits.GET("/:id/streak", getHabitStreak)
		}

		user := api.Group("/user")
		user.Use(requireAuth)
		{
			user.GET("/export", handleExportData)
			user.DELETE("/account", requireCSRF, handleDeleteAccount)
		}

		e2ee := api.Group("/e2ee")
		e2ee.Use(requireAuth)
		{
			e2ee.GET("", handleE2EEStatus)
			e2ee.POST("/enable", requireCSRF, handleE2EEEnable)
			e2ee.PUT("/passphrase", requireCSRF, handleE2EEChangePassphrase)
			e2ee.POST("/disable", requireCSRF, handleE2EEDisable)
		}

		sessionsGroup := api.Group("/sessions")
		sessionsGroup.Use(requireAuth)
		{
			sessionsGroup.GET("", handleListSessions)
			sessionsGroup.DELETE("/:id", requireCSRF, handleDeleteSession)
			sessionsGroup.POST("/logout-others", requireCSRF, handleLogoutOtherSessions)
		}

		passkeys := api.Group("/passkeys")
		passkeys.Use(requireAuth)
		{
			passkeys.GET("", handleListPasskeys)
			passkeys.POST("/register/begin", requireCSRF, handlePasskeyRegisterBegin)
			passkeys.POST("/register/finish", requireCSRF, handlePasskeyRegisterFinish)
			passkeys.PUT("/:id", requireCSRF, handleRenamePasskey)
			passkeys.DELETE("/:id", requireCSRF, handleDeletePasskey)
		}

		push := api.Group("/push")
		{
			push.GET("/vapid-public", handleVapidPublic)
			push.POST("/subscribe", requireAuth, requireCSRF, handlePushSubscribe)
			push.DELETE("/unsubscribe", requireAuth, requireCSRF, handlePushUnsubscribe)
			push.GET("/subscriptions", requireAuth, handlePushListSubscriptions)
			push.PUT("/subscriptions/:id", requireAuth, requireCSRF, handlePushUpdateSubscription)
			push.DELETE("/subscriptions/:id", requireAuth, requireCSRF, handlePushDeleteSubscription)
			push.POST("/subscriptions/:id/test", requireAuth, requireCSRF, handlePushTestSubscription)
		}
	}

	if smtpConfigured() {
		log.Printf("SMTP configured: host=%s port=%s user=%s",
			getEnv("SMTP_HOST", ""), getEnv("SMTP_PORT", "587"), getEnv("SMTP_USER", ""))
	} else {
		log.Printf("SMTP NOT configured — SMTP_HOST=%q SMTP_USER=%q SMTP_PASS=%s",
			getEnv("SMTP_HOST", ""), getEnv("SMTP_USER", ""),
			func() string {
				if getEnv("SMTP_PASS", "") != "" {
					return "(set)"
				}
				return "(empty)"
			}())
	}

	startScheduler()

	port := getEnv("PORT", "9090")
	log.Printf("Starting server on :%s", port)
	if err := router.Run(":" + port); err != nil {
		log.Fatal("Server failed:", err)
	}
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

// sanitizeDSN percent-encodes the password in a postgresql:// URI so that
// special characters (e.g. [ ] from Supabase-generated passwords) are valid.
// Key=value format DSNs are returned unchanged.
func sanitizeDSN(dsn string) string {
	schemeEnd := strings.Index(dsn, "://")
	if schemeEnd == -1 {
		return dsn // key=value format — no encoding needed
	}
	scheme := dsn[:schemeEnd+3]
	rest := dsn[schemeEnd+3:]

	atIdx := strings.LastIndex(rest, "@")
	if atIdx == -1 {
		return dsn
	}
	userinfo := rest[:atIdx]
	hostPart := rest[atIdx:] // includes the leading @

	colonIdx := strings.Index(userinfo, ":")
	if colonIdx == -1 {
		return dsn
	}
	user := userinfo[:colonIdx]
	password := userinfo[colonIdx+1:]

	return scheme + user + ":" + url.PathEscape(password) + hostPart
}

// seedInitialStreakFreezes ensures older accounts also start with 3 freezes.
func seedInitialStreakFreezes() {
	var users []User
	if err := db.Select("id").Find(&users).Error; err != nil {
		log.Printf("freeze seed skipped: failed to list users: %v", err)
		return
	}
	for _, user := range users {
		var freeze StreakFreeze
		err := db.Where("user_id = ?", user.ID).First(&freeze).Error
		if err == nil {
			continue
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			log.Printf("freeze seed skipped for user %s: %v", user.ID, err)
			continue
		}
		if createErr := db.Create(&StreakFreeze{UserID: user.ID, Count: 3}).Error; createErr != nil {
			log.Printf("freeze seed create failed for user %s: %v", user.ID, createErr)
		}
	}
}

func enforceUUIDUserIDSchema() {
	if !db.Migrator().HasTable(&User{}) {
		return
	}

	isUUID, err := usersIDIsUUID()
	if err != nil {
		log.Fatal("Failed to inspect users.id column:", err)
	}
	if isUUID {
		return
	}

	log.Fatal("Detected legacy numeric users.id schema. Manual migration required: recreate app tables as UUID-based before starting backend.")
}

func usersIDIsUUID() (bool, error) {
	type result struct {
		DataType string `gorm:"column:data_type"`
	}
	var r result
	err := db.Raw(`
		SELECT data_type
		FROM information_schema.columns
		WHERE table_schema = 'public'
		  AND table_name = 'users'
		  AND column_name = 'id'
		LIMIT 1
	`).Scan(&r).Error
	if err != nil {
		return false, err
	}
	return r.DataType == "uuid", nil
}

func parseSameSite(v string) http.SameSite {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "strict":
		return http.SameSiteStrictMode
	case "none":
		return http.SameSiteNoneMode
	default:
		return http.SameSiteLaxMode
	}
}

func buildSessionStore(secret string) cookie.Store {
	encryptionKeyB64 := getEnv("SESSION_ENCRYPTION_KEY", "")
	if encryptionKeyB64 == "" {
		if strings.EqualFold(getEnv("GIN_MODE", ""), "release") {
			log.Fatal("SESSION_ENCRYPTION_KEY is required when GIN_MODE=release")
		}
		log.Println("SESSION_ENCRYPTION_KEY not set: session payload will be signed but not encrypted")
		return cookie.NewStore([]byte(secret))
	}

	encryptionKey, err := base64.StdEncoding.DecodeString(encryptionKeyB64)
	if err != nil {
		log.Fatal("SESSION_ENCRYPTION_KEY must be valid base64")
	}
	switch len(encryptionKey) {
	case 16, 24, 32:
	default:
		log.Fatal("SESSION_ENCRYPTION_KEY decoded length must be 16, 24, or 32 bytes")
	}
	return cookie.NewStore([]byte(secret), encryptionKey)
}
