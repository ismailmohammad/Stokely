package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

// ── Auth Rate Limiter ─────────────────────────────────────────────────────────

type authBucket struct {
	mu        sync.Mutex
	count     int
	windowEnd time.Time
}

type loginBucket struct {
	mu        sync.Mutex
	count     int
	windowEnd time.Time
	lockUntil time.Time
}

var authLimitMap sync.Map
var authLimiterJanitorOnce sync.Once
var loginIPLimitMap sync.Map
var loginAccountLimitMap sync.Map
var loginLimiterJanitorOnce sync.Once

const authRateWindow = time.Minute
const authRateMax = 10
const forgotPasswordGenericMessage = "If an account exists, a password reset email has been sent" // #nosec G101 -- user-facing generic message, not a credential
const emailResendCooldown = 60 * time.Second
const loginFailureWindow = 10 * time.Minute
const loginIPMaxFailures = 25
const loginAccountMaxFailures = 8
const loginIPLockout = 10 * time.Minute
const loginAccountLockout = 15 * time.Minute

func startAuthRateLimiterJanitor() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for now := range ticker.C {
		authLimitMap.Range(func(key, value any) bool {
			b, ok := value.(*authBucket)
			if !ok {
				authLimitMap.Delete(key)
				return true
			}
			b.mu.Lock()
			expired := now.After(b.windowEnd.Add(5 * authRateWindow))
			b.mu.Unlock()
			if expired {
				authLimitMap.Delete(key)
			}
			return true
		})
	}
}

func checkAuthRateLimit(c *gin.Context) bool {
	authLimiterJanitorOnce.Do(func() { go startAuthRateLimiterJanitor() })
	ip := c.ClientIP()
	now := time.Now()
	val, _ := authLimitMap.LoadOrStore(ip, &authBucket{windowEnd: now.Add(authRateWindow)})
	b := val.(*authBucket)
	b.mu.Lock()
	defer b.mu.Unlock()
	if now.After(b.windowEnd) {
		b.count = 0
		b.windowEnd = now.Add(authRateWindow)
	}
	b.count++
	return b.count <= authRateMax
}

func startLoginLimiterJanitor() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for now := range ticker.C {
		cleanupLoginLimiterMap(&loginIPLimitMap, now)
		cleanupLoginLimiterMap(&loginAccountLimitMap, now)
	}
}

func cleanupLoginLimiterMap(m *sync.Map, now time.Time) {
	m.Range(func(key, value any) bool {
		b, ok := value.(*loginBucket)
		if !ok {
			m.Delete(key)
			return true
		}
		b.mu.Lock()
		windowExpired := now.After(b.windowEnd.Add(2 * loginFailureWindow))
		lockExpired := b.lockUntil.IsZero() || now.After(b.lockUntil.Add(2*loginAccountLockout))
		b.mu.Unlock()
		if windowExpired && lockExpired {
			m.Delete(key)
		}
		return true
	})
}

func loginIdentityKey(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

func getOrCreateLoginBucket(m *sync.Map, key string, now time.Time) *loginBucket {
	val, _ := m.LoadOrStore(key, &loginBucket{windowEnd: now.Add(loginFailureWindow)})
	return val.(*loginBucket)
}

func loginBucketLockRemaining(m *sync.Map, key string, now time.Time) time.Duration {
	if key == "" {
		return 0
	}
	val, ok := m.Load(key)
	if !ok {
		return 0
	}
	b, ok := val.(*loginBucket)
	if !ok {
		m.Delete(key)
		return 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if now.Before(b.lockUntil) {
		return b.lockUntil.Sub(now)
	}
	return 0
}

func recordFailure(m *sync.Map, key string, now time.Time, maxFailures int, lockout time.Duration) time.Duration {
	if key == "" {
		return 0
	}
	b := getOrCreateLoginBucket(m, key, now)
	b.mu.Lock()
	defer b.mu.Unlock()

	if now.Before(b.lockUntil) {
		return b.lockUntil.Sub(now)
	}
	if now.After(b.windowEnd) {
		b.count = 0
		b.windowEnd = now.Add(loginFailureWindow)
	}
	b.count++
	if b.count >= maxFailures {
		b.count = 0
		b.lockUntil = now.Add(lockout)
		return lockout
	}
	return 0
}

func loginLockoutRemaining(ip, username string, now time.Time) time.Duration {
	ipRemaining := loginBucketLockRemaining(&loginIPLimitMap, strings.TrimSpace(ip), now)
	accountRemaining := loginBucketLockRemaining(&loginAccountLimitMap, loginIdentityKey(username), now)
	if accountRemaining > ipRemaining {
		return accountRemaining
	}
	return ipRemaining
}

func recordLoginFailure(ip, username string, now time.Time) time.Duration {
	loginLimiterJanitorOnce.Do(func() { go startLoginLimiterJanitor() })
	ipRemaining := recordFailure(&loginIPLimitMap, strings.TrimSpace(ip), now, loginIPMaxFailures, loginIPLockout)
	accountRemaining := recordFailure(&loginAccountLimitMap, loginIdentityKey(username), now, loginAccountMaxFailures, loginAccountLockout)
	if accountRemaining > ipRemaining {
		return accountRemaining
	}
	return ipRemaining
}

func clearLoginFailures(ip, username string) {
	loginIPLimitMap.Delete(strings.TrimSpace(ip))
	if key := loginIdentityKey(username); key != "" {
		loginAccountLimitMap.Delete(key)
	}
}

// ── Input Validators ──────────────────────────────────────────────────────────

var validDayCodes = map[string]bool{
	"Su": true, "Mo": true, "Tu": true, "We": true, "Th": true, "Fr": true, "Sa": true,
}

func isValidRecurrence(r string) bool {
	parts := strings.Split(r, "-")
	if len(parts) == 0 || len(parts) > 7 {
		return false
	}
	seen := map[string]bool{}
	for _, p := range parts {
		if !validDayCodes[p] || seen[p] {
			return false
		}
		seen[p] = true
	}
	return true
}

var reminderTimeRe = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)

func isValidReminderTime(t string) bool {
	return t == "" || reminderTimeRe.MatchString(t)
}

func isValidTimeZone(tz string) bool {
	if tz == "" {
		return true
	}
	_, err := time.LoadLocation(tz)
	return err == nil
}

func isE2EEEncryptedValue(value string) bool {
	return strings.HasPrefix(value, "e2ee:v1:")
}

func isValidE2EEHabitPayload(name, notes string) bool {
	if !isE2EEEncryptedValue(name) {
		return false
	}
	return notes == "" || isE2EEEncryptedValue(notes)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func dayCode(t time.Time) string {
	switch t.UTC().Weekday() {
	case time.Sunday:
		return "Su"
	case time.Monday:
		return "Mo"
	case time.Tuesday:
		return "Tu"
	case time.Wednesday:
		return "We"
	case time.Thursday:
		return "Th"
	case time.Friday:
		return "Fr"
	case time.Saturday:
		return "Sa"
	default:
		return ""
	}
}

func containsDay(recurrence, dayKey string) bool {
	for _, p := range strings.Split(recurrence, "-") {
		if p == dayKey {
			return true
		}
	}
	return false
}

func parseDateOrToday(dateStr string) (time.Time, error) {
	if dateStr == "" {
		return time.Now().UTC().Truncate(24 * time.Hour), nil
	}
	t, err := time.Parse("2006-01-02", dateStr)
	if err != nil {
		return time.Time{}, err
	}
	return t.UTC(), nil
}

func hashEmailToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func cooldownCeilSeconds(d time.Duration) int {
	if d <= 0 {
		return 0
	}
	secs := int(d / time.Second)
	if d%time.Second != 0 {
		secs++
	}
	if secs < 1 {
		return 1
	}
	return secs
}

func resendCooldownRemaining(lastCreatedAt, now time.Time) time.Duration {
	if lastCreatedAt.IsZero() {
		return 0
	}
	nextAllowed := lastCreatedAt.Add(emailResendCooldown)
	if !now.Before(nextAllowed) {
		return 0
	}
	return nextAllowed.Sub(now)
}

func emailResendCooldownRemaining(userID, tokenType string, now time.Time) time.Duration {
	var existing EmailToken
	err := db.Where("user_id = ? AND type = ?", userID, tokenType).
		Order("created_at desc").
		First(&existing).Error
	if err != nil {
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			log.Printf("email cooldown lookup failed for user=%s type=%s: %v", userID, tokenType, err)
		}
		return 0
	}
	return resendCooldownRemaining(existing.CreatedAt.UTC(), now.UTC())
}

// computeStreak counts consecutive completed (or frozen) scheduled days, ending at referenceDate.
// If today is a scheduled day but not yet logged, it is skipped without breaking the streak.
func computeStreak(habit Habit, userID string, referenceDate time.Time) (streak int, hasFreeze bool) {
	var freeze StreakFreeze
	db.Where("user_id = ?", userID).First(&freeze)
	hasFreeze = freeze.Count > 0

	today := referenceDate.UTC().Truncate(24 * time.Hour)
	windowStart := today.AddDate(0, 0, -90)

	var logs []HabitLog
	db.Where("habit_id = ? AND log_date >= ?", habit.ID, windowStart).Find(&logs)

	loggedDates := map[string]bool{}
	for _, l := range logs {
		loggedDates[l.LogDate.UTC().Truncate(24*time.Hour).Format("2006-01-02")] = true
	}

	streak = streakFromLoggedDates(habit, loggedDates, today, windowStart)
	return streak, hasFreeze
}

// computeStreakFromLogs computes streak using pre-loaded data (no DB calls).
// logsByHabit maps habitID → logs already fetched for the 90-day window.
func computeStreakFromLogs(habit Habit, logsByHabit map[uint][]HabitLog, referenceDate time.Time) int {
	today := referenceDate.UTC().Truncate(24 * time.Hour)
	windowStart := today.AddDate(0, 0, -90)

	loggedDates := map[string]bool{}
	for _, l := range logsByHabit[habit.ID] {
		loggedDates[l.LogDate.UTC().Truncate(24*time.Hour).Format("2006-01-02")] = true
	}
	return streakFromLoggedDates(habit, loggedDates, today, windowStart)
}

func streakFromLoggedDates(habit Habit, loggedDates map[string]bool, today, windowStart time.Time) int {
	streak := 0
	for d := today; !d.Before(windowStart); d = d.AddDate(0, 0, -1) {
		if !containsDay(habit.Recurrence, dayCode(d)) {
			continue
		}
		if habit.RecurrenceEnd != nil && d.After(habit.RecurrenceEnd.UTC().Truncate(24*time.Hour)) {
			continue
		}
		dateStr := d.Format("2006-01-02")
		if loggedDates[dateStr] {
			streak++
		} else if d.Equal(today) {
			// Today not yet completed — skip without breaking streak
			continue
		} else {
			break
		}
	}
	return streak
}

func habitToResponse(h Habit, complete bool, streak int, hasFreeze bool, frozenToday bool) HabitResponse {
	return HabitResponse{
		ID:            h.ID,
		CreatedAt:     h.CreatedAt,
		Name:          h.Name,
		Complete:      complete,
		Recurrence:    h.Recurrence,
		PositiveType:  h.PositiveType,
		Icon:          h.Icon,
		RecurrenceEnd: h.RecurrenceEnd,
		Notes:         h.Notes,
		ReminderTime:  h.ReminderTime,
		ReminderTZ:    h.ReminderTZ,
		Streak:        streak,
		HasFreeze:     hasFreeze,
		FrozenToday:   frozenToday,
	}
}

// todayFrozen checks whether a frozen HabitLog exists for today for the given habit.
func todayFrozen(habitID uint, userID string) bool {
	today := time.Now().UTC().Truncate(24 * time.Hour)
	var count int64
	db.Model(&HabitLog{}).
		Where("habit_id = ? AND user_id = ? AND log_date = ? AND was_frozen = true", habitID, userID, today).
		Count(&count)
	return count > 0
}

// awardFreezeIfMilestone grants the user one streak freeze at every 7-day streak milestone.
func awardFreezeIfMilestone(userID string, habit Habit, logDate time.Time) {
	streak, _ := computeStreak(habit, userID, logDate)
	if streak > 0 && streak%7 == 0 {
		var freeze StreakFreeze
		db.Where(StreakFreeze{UserID: userID}).FirstOrCreate(&freeze)
		freeze.Count++
		db.Save(&freeze)
	}
}

// todayComplete checks whether a non-frozen HabitLog exists for today.
func todayComplete(habitID uint, userID string) bool {
	today := time.Now().UTC().Truncate(24 * time.Hour)
	var count int64
	db.Model(&HabitLog{}).
		Where("habit_id = ? AND user_id = ? AND log_date = ? AND was_frozen = false", habitID, userID, today).
		Count(&count)
	return count > 0
}

func isWelcomePending(user *User) bool {
	return !user.WelcomeSeen
}

func consumeE2EESetupPrompt(user *User) bool {
	if user.E2EEEnabled || !user.E2EEPromptPending {
		return false
	}
	res := db.Model(&User{}).Where("id = ?", user.ID).UpdateColumn("e2ee_prompt_pending", false)
	if res.Error != nil || res.RowsAffected == 0 {
		return false
	}
	user.E2EEPromptPending = false
	return true
}

func setAuthenticatedSession(c *gin.Context, userID string) error {
	sessionID, err := generateSessionID()
	if err != nil {
		return err
	}
	session := sessions.Default(c)
	session.Clear()
	session.Set("userID", userID)
	session.Set("sessionID", sessionID)
	token, err := generateCSRFToken()
	if err != nil {
		return err
	}
	session.Set("csrfToken", token)
	if err := session.Save(); err != nil {
		return err
	}
	setCSRFCookie(c, token)
	now := time.Now().UTC()
	db.Create(&UserSession{
		ID:         sessionID,
		UserID:     userID,
		LastSeenAt: now,
		// Privacy-minimized session metadata: do not persist raw user agent or IP.
		UserAgent: "",
		IPAddress: "",
	})
	return nil
}

func clearSession(c *gin.Context) error {
	session := sessions.Default(c)
	session.Clear()
	if err := session.Save(); err != nil {
		return err
	}
	clearCSRFCookie(c)
	return nil
}

func generateCSRFToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func generateSessionID() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func setCSRFCookie(c *gin.Context, token string) {
	c.SetSameSite(sessionCookieSameSite)
	c.SetCookie("stokely-csrf", token, sessionMaxAgeSeconds, "/", sessionCookieDomain, sessionCookieSecure, false)
}

func clearCSRFCookie(c *gin.Context) {
	c.SetSameSite(sessionCookieSameSite)
	c.SetCookie("stokely-csrf", "", -1, "/", sessionCookieDomain, sessionCookieSecure, false)
}

func requireCSRF(c *gin.Context) {
	switch c.Request.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		c.Next()
		return
	}

	session := sessions.Default(c)
	raw := session.Get("csrfToken")
	token, ok := raw.(string)
	if !ok || token == "" {
		c.JSON(http.StatusForbidden, gin.H{"error": "CSRF token missing"})
		c.Abort()
		return
	}

	headerToken := c.GetHeader("X-CSRF-Token")
	if headerToken == "" || subtle.ConstantTimeCompare([]byte(headerToken), []byte(token)) != 1 {
		c.JSON(http.StatusForbidden, gin.H{"error": "Invalid CSRF token"})
		c.Abort()
		return
	}

	c.Next()
}

func ensureCSRFFromSession(c *gin.Context, session sessions.Session) error {
	raw := session.Get("csrfToken")
	token, ok := raw.(string)
	if ok && token != "" {
		setCSRFCookie(c, token)
		return nil
	}

	newToken, err := generateCSRFToken()
	if err != nil {
		return err
	}
	session.Set("csrfToken", newToken)
	if err := session.Save(); err != nil {
		return err
	}
	setCSRFCookie(c, newToken)
	return nil
}

func longestStreakEver(h Habit, logs []HabitLog) int {
	if len(logs) == 0 {
		return 0
	}

	loggedDates := map[string]bool{}
	maxLogDate := logs[0].LogDate.UTC().Truncate(24 * time.Hour)
	for _, l := range logs {
		d := l.LogDate.UTC().Truncate(24 * time.Hour)
		loggedDates[d.Format("2006-01-02")] = true
		if d.After(maxLogDate) {
			maxLogDate = d
		}
	}

	start := h.CreatedAt.UTC().Truncate(24 * time.Hour)
	end := maxLogDate
	if h.RecurrenceEnd != nil {
		recEnd := h.RecurrenceEnd.UTC().Truncate(24 * time.Hour)
		if recEnd.Before(end) {
			end = recEnd
		}
	}
	if end.Before(start) {
		return 0
	}

	longest := 0
	running := 0
	for d := start; !d.After(end); d = d.AddDate(0, 0, 1) {
		if !containsDay(h.Recurrence, dayCode(d)) {
			continue
		}
		if h.RecurrenceEnd != nil && d.After(h.RecurrenceEnd.UTC().Truncate(24*time.Hour)) {
			break
		}

		if loggedDates[d.Format("2006-01-02")] {
			running++
			if running > longest {
				longest = running
			}
		} else {
			running = 0
		}
	}
	return longest
}

// ── Auth ──────────────────────────────────────────────────────────────────────

func handleRegister(c *gin.Context) {
	if !checkAuthRateLimit(c) {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "Too many attempts, please try again later"})
		return
	}
	var input struct {
		Username string  `json:"username" binding:"required,min=3,max=50"`
		Password string  `json:"password" binding:"required,min=8,max=128"`
		Email    *string `json:"email"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if input.Email != nil && strings.TrimSpace(*input.Email) == "" {
		input.Email = nil
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(input.Password), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to process password"})
		return
	}

	// Email is verified via a separate flow; don't store it on the user at registration.
	user := User{
		Username:          input.Username,
		Password:          string(hash),
		DailySparkEnabled: true,
	}
	if result := db.Create(&user); result.Error != nil {
		errMsg := result.Error.Error()
		if strings.Contains(errMsg, "username") || strings.Contains(errMsg, "unique") {
			c.JSON(http.StatusConflict, gin.H{"error": "Username already taken"})
		} else {
			c.JSON(http.StatusConflict, gin.H{"error": "Registration failed"})
		}
		return
	}

	// Give every new user 3 streak freezes to start
	db.Create(&StreakFreeze{UserID: user.ID, Count: 3})

	if err := setAuthenticatedSession(c, user.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create session"})
		return
	}

	// If an email was provided, queue a verification email (don't store until verified).
	emailPending := false
	if input.Email != nil {
		if err := queueEmailVerification(user.ID, user.Username, *input.Email); err == nil {
			emailPending = true
		}
	}

	showWelcome := isWelcomePending(&user)
	e2eeSetupPrompt := consumeE2EESetupPrompt(&user)
	c.JSON(http.StatusCreated, gin.H{
		"id":                user.ID,
		"username":          user.Username,
		"email":             user.Email,
		"emailVerified":     user.EmailVerified,
		"emailPending":      emailPending,
		"showWelcome":       showWelcome,
		"dailySparkEnabled": user.DailySparkEnabled,
		"e2eeEnabled":       user.E2EEEnabled,
		"e2eeSetupPrompt":   e2eeSetupPrompt,
	})
}

func handleLogin(c *gin.Context) {
	if !checkAuthRateLimit(c) {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "Too many attempts, please try again later"})
		return
	}
	var input struct {
		Username string `json:"username" binding:"required,max=50"`
		Password string `json:"password" binding:"required,max=128"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	now := time.Now().UTC()
	if remaining := loginLockoutRemaining(c.ClientIP(), input.Username, now); remaining > 0 {
		secs := cooldownCeilSeconds(remaining)
		c.Header("Retry-After", strconv.Itoa(secs))
		c.JSON(http.StatusTooManyRequests, gin.H{"error": fmt.Sprintf("Too many login attempts. Try again in %d seconds", secs)})
		return
	}

	var user User
	if result := db.Where("username = ?", input.Username).First(&user); result.Error != nil {
		if remaining := recordLoginFailure(c.ClientIP(), input.Username, now); remaining > 0 {
			secs := cooldownCeilSeconds(remaining)
			c.Header("Retry-After", strconv.Itoa(secs))
			c.JSON(http.StatusTooManyRequests, gin.H{"error": fmt.Sprintf("Too many login attempts. Try again in %d seconds", secs)})
			return
		}
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid username or password"})
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(input.Password)); err != nil {
		if remaining := recordLoginFailure(c.ClientIP(), input.Username, now); remaining > 0 {
			secs := cooldownCeilSeconds(remaining)
			c.Header("Retry-After", strconv.Itoa(secs))
			c.JSON(http.StatusTooManyRequests, gin.H{"error": fmt.Sprintf("Too many login attempts. Try again in %d seconds", secs)})
			return
		}
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid username or password"})
		return
	}
	clearLoginFailures(c.ClientIP(), input.Username)

	if err := setAuthenticatedSession(c, user.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create session"})
		return
	}

	showWelcome := isWelcomePending(&user)
	e2eeSetupPrompt := consumeE2EESetupPrompt(&user)
	passkeyCount, _ := countUserPasskeys(user.ID)
	c.JSON(http.StatusOK, gin.H{
		"id":                user.ID,
		"username":          user.Username,
		"email":             user.Email,
		"emailVerified":     user.EmailVerified,
		"showWelcome":       showWelcome,
		"dailySparkEnabled": user.DailySparkEnabled,
		"e2eeEnabled":       user.E2EEEnabled,
		"e2eeSetupPrompt":   e2eeSetupPrompt,
		"hasPasskeys":       passkeyCount > 0,
	})
}

func handleLogout(c *gin.Context) {
	if sid, exists := c.Get("sessionID"); exists {
		if id, ok := sid.(string); ok && id != "" {
			db.Where("id = ?", id).Delete(&UserSession{})
		}
	}
	if err := clearSession(c); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to clear session"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Logged out"})
}

func handleMe(c *gin.Context) {
	user := c.MustGet("user").(User)
	showWelcome := isWelcomePending(&user)
	e2eeSetupPrompt := consumeE2EESetupPrompt(&user)
	passkeyCount, _ := countUserPasskeys(user.ID)
	c.JSON(http.StatusOK, gin.H{
		"id":                user.ID,
		"username":          user.Username,
		"email":             user.Email,
		"emailVerified":     user.EmailVerified,
		"showWelcome":       showWelcome,
		"dailySparkEnabled": user.DailySparkEnabled,
		"e2eeEnabled":       user.E2EEEnabled,
		"e2eeSetupPrompt":   e2eeSetupPrompt,
		"hasPasskeys":       passkeyCount > 0,
	})
}

func handleWelcomeSeen(c *gin.Context) {
	user := c.MustGet("user").(User)
	if !user.WelcomeSeen {
		db.Model(&user).UpdateColumn("welcome_seen", true)
	}
	c.JSON(http.StatusOK, gin.H{"message": "Welcome acknowledged"})
}

func handleDailySparkPreference(c *gin.Context) {
	user := c.MustGet("user").(User)
	var input struct {
		Enabled *bool `json:"enabled" binding:"required"`
	}
	if err := c.ShouldBindJSON(&input); err != nil || input.Enabled == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "enabled is required"})
		return
	}
	if err := db.Model(&user).UpdateColumn("daily_spark_enabled", *input.Enabled).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update daily spark preference"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"dailySparkEnabled": *input.Enabled})
}

func requireAuth(c *gin.Context) {
	session := sessions.Default(c)
	raw := session.Get("userID")
	if raw == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Not authenticated"})
		c.Abort()
		return
	}

	userID, ok := raw.(string)
	if !ok || userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid session"})
		c.Abort()
		return
	}

	// Validate session ID against DB (sessions created before this feature lack a sessionID
	// and are allowed through for backward compatibility until they log in again).
	if rawSID := session.Get("sessionID"); rawSID != nil {
		sessionID, _ := rawSID.(string)
		if sessionID != "" {
			var userSession UserSession
			if err := db.Where("id = ? AND user_id = ?", sessionID, userID).First(&userSession).Error; err != nil {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "Session revoked"})
				c.Abort()
				return
			}
			// Throttle LastSeenAt updates to avoid a write on every request.
			if time.Since(userSession.LastSeenAt) > 5*time.Minute {
				db.Model(&userSession).UpdateColumn("last_seen_at", time.Now().UTC())
			}
			c.Set("sessionID", sessionID)
		}
	}

	var user User
	if result := db.First(&user, "id = ?", userID); result.Error != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "User not found"})
		c.Abort()
		return
	}
	if err := ensureCSRFFromSession(c, session); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to initialize CSRF session"})
		c.Abort()
		return
	}

	c.Set("user", user)
	c.Next()
}

// ── Habits ────────────────────────────────────────────────────────────────────

func getHabits(c *gin.Context) {
	user := c.MustGet("user").(User)

	dateStr := c.Query("date")
	targetDate, err := parseDateOrToday(dateStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid date format, use YYYY-MM-DD"})
		return
	}

	view := c.Query("view")
	if view == "" {
		view = "daily"
	}

	var habits []Habit
	db.Where("user_id = ?", user.ID).Order("created_at asc").Find(&habits)

	// For daily view, allow streak visuals to reflect future-dated logs.
	// Map habit_id -> max logged date so fiery state remains consistent after future logs.
	maxLoggedByHabit := map[uint]time.Time{}
	if view == "daily" && len(habits) > 0 {
		type maxLogRow struct {
			HabitID    uint      `gorm:"column:habit_id"`
			MaxLogDate time.Time `gorm:"column:max_log_date"`
		}
		var maxRows []maxLogRow
		db.Model(&HabitLog{}).
			Select("habit_id, MAX(log_date) AS max_log_date").
			Where("user_id = ?", user.ID).
			Group("habit_id").
			Scan(&maxRows)
		for _, row := range maxRows {
			if !row.MaxLogDate.IsZero() {
				maxLoggedByHabit[row.HabitID] = row.MaxLogDate.UTC().Truncate(24 * time.Hour)
			}
		}
	}

	// Load all non-frozen logs for this user on targetDate in one query
	var logs []HabitLog
	db.Where("user_id = ? AND log_date = ? AND was_frozen = false", user.ID, targetDate).Find(&logs)
	completedIDs := map[uint]bool{}
	for _, l := range logs {
		completedIDs[l.HabitID] = true
	}

	// Load frozen logs for targetDate so we can set frozenToday correctly.
	var frozenLogs []HabitLog
	db.Where("user_id = ? AND log_date = ? AND was_frozen = true", user.ID, targetDate).Find(&frozenLogs)
	frozenTodayIDs := map[uint]bool{}
	for _, l := range frozenLogs {
		frozenTodayIDs[l.HabitID] = true
	}

	// Batch-load streak data once for all habits (avoids N+1).
	var freeze StreakFreeze
	db.Where("user_id = ?", user.ID).First(&freeze)
	hasFreeze := freeze.Count > 0

	windowStart := time.Now().UTC().Truncate(24*time.Hour).AddDate(0, 0, -90)
	logsByHabit := map[uint][]HabitLog{}
	if len(habits) > 0 {
		habitIDs := make([]uint, len(habits))
		for i, h := range habits {
			habitIDs[i] = h.ID
		}
		var streakLogs []HabitLog
		db.Where("habit_id IN ? AND log_date >= ?", habitIDs, windowStart).Find(&streakLogs)
		for _, l := range streakLogs {
			logsByHabit[l.HabitID] = append(logsByHabit[l.HabitID], l)
		}
	}

	todayKey := dayCode(targetDate)

	result := make([]HabitResponse, 0, len(habits))
	for _, h := range habits {
		if view == "daily" || view == "calendar" {
			endedBeforeTarget := h.RecurrenceEnd != nil &&
				targetDate.After(h.RecurrenceEnd.UTC().Truncate(24*time.Hour))

			// Keep ended habits visible so UI can place them in Archived
			// instead of dropping them from the date view entirely.
			if !endedBeforeTarget && !containsDay(h.Recurrence, todayKey) {
				continue
			}
		}
		streakRefDate := targetDate
		if maxDate, ok := maxLoggedByHabit[h.ID]; ok && maxDate.After(streakRefDate) {
			streakRefDate = maxDate
		}

		streak := computeStreakFromLogs(h, logsByHabit, streakRefDate)
		result = append(result, habitToResponse(h, completedIDs[h.ID], streak, hasFreeze, frozenTodayIDs[h.ID]))
	}

	c.JSON(http.StatusOK, result)
}

func createHabit(c *gin.Context) {
	user := c.MustGet("user").(User)
	var input struct {
		Name          string     `json:"name" binding:"required,max=500"`
		Recurrence    string     `json:"recurrence" binding:"required"`
		PositiveType  bool       `json:"positiveType"`
		Icon          string     `json:"icon" binding:"max=100"`
		RecurrenceEnd *time.Time `json:"recurrenceEnd"`
		Notes         string     `json:"notes" binding:"max=2000"`
		ReminderTime  string     `json:"reminderTime"`
		ReminderTZ    string     `json:"reminderTz" binding:"max=64"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if !isValidRecurrence(input.Recurrence) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid recurrence format"})
		return
	}
	input.ReminderTZ = strings.TrimSpace(input.ReminderTZ)
	if !isValidReminderTime(input.ReminderTime) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid reminder time, expected HH:MM"})
		return
	}
	if !isValidTimeZone(input.ReminderTZ) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid reminder timezone"})
		return
	}
	if user.E2EEEnabled && !isValidE2EEHabitPayload(input.Name, input.Notes) {
		c.JSON(http.StatusLocked, gin.H{"error": "Vault is locked. Unlock vault before adding habits while E2EE is enabled"})
		return
	}

	habit := Habit{
		UserID:        user.ID,
		Name:          input.Name,
		Recurrence:    input.Recurrence,
		PositiveType:  input.PositiveType,
		Icon:          input.Icon,
		RecurrenceEnd: input.RecurrenceEnd,
		Notes:         input.Notes,
		ReminderTime:  input.ReminderTime,
		ReminderTZ:    input.ReminderTZ,
	}
	db.Create(&habit)
	c.JSON(http.StatusCreated, habitToResponse(habit, false, 0, false, false))
}

func updateHabit(c *gin.Context) {
	user := c.MustGet("user").(User)
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid ID"})
		return
	}

	var habit Habit
	if result := db.Where("id = ? AND user_id = ?", id, user.ID).First(&habit); result.Error != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Habit not found"})
		return
	}

	var input struct {
		Name          *string    `json:"name"`
		Complete      *bool      `json:"complete"` // kept for backward compat; syncs HabitLog
		Recurrence    *string    `json:"recurrence"`
		PositiveType  *bool      `json:"positiveType"`
		Icon          *string    `json:"icon"`
		RecurrenceEnd *time.Time `json:"recurrenceEnd"`
		Notes         *string    `json:"notes"`
		ReminderTime  *string    `json:"reminderTime"`
		ReminderTZ    *string    `json:"reminderTz"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if input.Name != nil {
		if len(*input.Name) == 0 || len(*input.Name) > 500 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Name must be between 1 and 500 characters"})
			return
		}
		habit.Name = *input.Name
	}
	if input.Recurrence != nil {
		if !isValidRecurrence(*input.Recurrence) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid recurrence format"})
			return
		}
		habit.Recurrence = *input.Recurrence
	}
	if input.PositiveType != nil {
		habit.PositiveType = *input.PositiveType
	}
	if input.Icon != nil {
		habit.Icon = *input.Icon
	}
	if input.RecurrenceEnd != nil {
		habit.RecurrenceEnd = input.RecurrenceEnd
	}
	if input.Notes != nil {
		habit.Notes = *input.Notes
	}
	if input.ReminderTime != nil {
		if !isValidReminderTime(*input.ReminderTime) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid reminder time, expected HH:MM"})
			return
		}
		habit.ReminderTime = *input.ReminderTime
	}
	if input.ReminderTZ != nil {
		trimmed := strings.TrimSpace(*input.ReminderTZ)
		if !isValidTimeZone(trimmed) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid reminder timezone"})
			return
		}
		habit.ReminderTZ = trimmed
	}

	// Backward compat: sync HabitLog when complete flag is toggled
	if input.Complete != nil {
		today := time.Now().UTC().Truncate(24 * time.Hour)
		if *input.Complete {
			logEntry := HabitLog{HabitID: habit.ID, UserID: user.ID, LogDate: today}
			db.Where(HabitLog{HabitID: habit.ID, UserID: user.ID, LogDate: today}).FirstOrCreate(&logEntry)
			awardFreezeIfMilestone(user.ID, habit, today)
		} else {
			db.Where("habit_id = ? AND user_id = ? AND log_date = ? AND was_frozen = false",
				habit.ID, user.ID, today).Delete(&HabitLog{})
		}
	}

	db.Save(&habit)

	complete := todayComplete(habit.ID, user.ID)
	today := time.Now().UTC().Truncate(24 * time.Hour)
	streak, hasFreeze := computeStreak(habit, user.ID, today)
	c.JSON(http.StatusOK, habitToResponse(habit, complete, streak, hasFreeze, todayFrozen(habit.ID, user.ID)))
}

func deleteHabit(c *gin.Context) {
	user := c.MustGet("user").(User)
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid ID"})
		return
	}

	result := db.Where("id = ? AND user_id = ?", id, user.ID).Delete(&Habit{})
	if result.Error != nil || result.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "Habit not found"})
		return
	}

	// Clean up associated logs
	db.Where("habit_id = ?", id).Delete(&HabitLog{})

	c.JSON(http.StatusOK, gin.H{"message": "Deleted"})
}

// ── HabitLog (toggle completion by date) ──────────────────────────────────────

func createHabitLog(c *gin.Context) {
	user := c.MustGet("user").(User)
	habitID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid ID"})
		return
	}

	var habit Habit
	if result := db.Where("id = ? AND user_id = ?", habitID, user.ID).First(&habit); result.Error != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Habit not found"})
		return
	}

	var input struct {
		Date string `json:"date"`
	}
	if err := c.ShouldBindJSON(&input); err != nil && !errors.Is(err, io.EOF) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	logDate, err := parseDateOrToday(input.Date)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid date format, use YYYY-MM-DD"})
		return
	}

	logEntry := HabitLog{HabitID: habit.ID, UserID: user.ID, LogDate: logDate}
	if result := db.Create(&logEntry); result.Error != nil {
		c.JSON(http.StatusConflict, gin.H{"error": "Already logged for this date"})
		return
	}

	awardFreezeIfMilestone(user.ID, habit, logDate)
	c.JSON(http.StatusCreated, gin.H{"message": "Logged"})
}

func deleteHabitLog(c *gin.Context) {
	user := c.MustGet("user").(User)
	habitID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid ID"})
		return
	}

	var habit Habit
	if result := db.Where("id = ? AND user_id = ?", habitID, user.ID).First(&habit); result.Error != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Habit not found"})
		return
	}

	var input struct {
		Date string `json:"date"`
	}
	if err := c.ShouldBindJSON(&input); err != nil && !errors.Is(err, io.EOF) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	logDate, err := parseDateOrToday(input.Date)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid date format, use YYYY-MM-DD"})
		return
	}

	db.Where("habit_id = ? AND user_id = ? AND log_date = ? AND was_frozen = false",
		habitID, user.ID, logDate).Delete(&HabitLog{})
	c.JSON(http.StatusOK, gin.H{"message": "Unlogged"})
}

// ── Streak ────────────────────────────────────────────────────────────────────

type DayStatus struct {
	Date      string `json:"date"`
	Scheduled bool   `json:"scheduled"`
	Completed bool   `json:"completed"`
	Frozen    bool   `json:"frozen"`
}

type StreakDetail struct {
	CurrentStreak int         `json:"currentStreak"`
	LongestStreak int         `json:"longestStreak"`
	FreezeCount   int         `json:"freezeCount"`
	History       []DayStatus `json:"history"`
}

type Achievement struct {
	Key         string `json:"key"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Unlocked    bool   `json:"unlocked"`
}

func getHabitStreak(c *gin.Context) {
	user := c.MustGet("user").(User)
	habitID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid ID"})
		return
	}

	var habit Habit
	if result := db.Where("id = ? AND user_id = ?", habitID, user.ID).First(&habit); result.Error != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Habit not found"})
		return
	}

	today := time.Now().UTC().Truncate(24 * time.Hour)
	windowStart := today.AddDate(0, 0, -29) // 30 days

	var logs []HabitLog
	db.Where("habit_id = ? AND log_date >= ?", habit.ID, windowStart).Find(&logs)

	logMap := map[string]HabitLog{}
	for _, l := range logs {
		logMap[l.LogDate.UTC().Truncate(24*time.Hour).Format("2006-01-02")] = l
	}

	history := make([]DayStatus, 0, 30)
	for d := windowStart; !d.After(today); d = d.AddDate(0, 0, 1) {
		dateStr := d.Format("2006-01-02")
		scheduled := containsDay(habit.Recurrence, dayCode(d))
		if habit.RecurrenceEnd != nil && d.After(habit.RecurrenceEnd.UTC().Truncate(24*time.Hour)) {
			scheduled = false
		}
		l, logged := logMap[dateStr]
		history = append(history, DayStatus{
			Date:      dateStr,
			Scheduled: scheduled,
			Completed: logged && !l.WasFrozen,
			Frozen:    logged && l.WasFrozen,
		})
	}

	currentStreak, _ := computeStreak(habit, user.ID, today)

	longestStreak, running := 0, 0
	for _, day := range history {
		if day.Scheduled && (day.Completed || day.Frozen) {
			running++
			if running > longestStreak {
				longestStreak = running
			}
		} else if day.Scheduled {
			running = 0
		}
	}

	var freeze StreakFreeze
	db.Where("user_id = ?", user.ID).First(&freeze)

	c.JSON(http.StatusOK, StreakDetail{
		CurrentStreak: currentStreak,
		LongestStreak: longestStreak,
		FreezeCount:   freeze.Count,
		History:       history,
	})
}

func getAchievements(c *gin.Context) {
	user := c.MustGet("user").(User)

	var habits []Habit
	db.Where("user_id = ?", user.ID).Find(&habits)

	var logs []HabitLog
	db.Where("user_id = ?", user.ID).Find(&logs)

	hasRealCompletion := false
	logsByHabit := map[uint][]HabitLog{}
	for _, l := range logs {
		if !l.WasFrozen {
			hasRealCompletion = true
		}
		logsByHabit[l.HabitID] = append(logsByHabit[l.HabitID], l)
	}

	longestAnyHabit := 0
	for _, h := range habits {
		longest := longestStreakEver(h, logsByHabit[h.ID])
		if longest > longestAnyHabit {
			longestAnyHabit = longest
		}
	}

	achievements := []Achievement{
		{
			Key:         "first_completion",
			Title:       "First Completion",
			Description: "Complete your first habit log.",
			Unlocked:    hasRealCompletion,
		},
		{
			Key:         "first_streak",
			Title:       "First Streak",
			Description: "Reach your first 2-day streak.",
			Unlocked:    longestAnyHabit >= 2,
		},
		{
			Key:         "streak_7",
			Title:       "7 Day Flame",
			Description: "Reach a 7-day streak on any habit.",
			Unlocked:    longestAnyHabit >= 7,
		},
		{
			Key:         "streak_21",
			Title:       "21 Day Momentum",
			Description: "Reach a 21-day streak on any habit.",
			Unlocked:    longestAnyHabit >= 21,
		},
		{
			Key:         "streak_90",
			Title:       "90 Day Forge",
			Description: "Reach a 90-day streak on any habit.",
			Unlocked:    longestAnyHabit >= 90,
		},
		{
			Key:         "streak_365",
			Title:       "365 Day Legend",
			Description: "Reach a 365-day streak on any habit.",
			Unlocked:    longestAnyHabit >= 365,
		},
	}

	c.JSON(http.StatusOK, achievements)
}

// ── User Settings ─────────────────────────────────────────────────────────────

func handleChangePassword(c *gin.Context) {
	user := c.MustGet("user").(User)
	var input struct {
		CurrentPassword string `json:"currentPassword" binding:"required"`
		NewPassword     string `json:"newPassword" binding:"required,min=8"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(input.CurrentPassword)); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Current password is incorrect"})
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(input.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to process password"})
		return
	}
	tx := db.Begin()
	if tx.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to start password update"})
		return
	}
	if err := tx.Model(&User{}).Where("id = ?", user.ID).UpdateColumn("password", string(hash)).Error; err != nil {
		tx.Rollback()
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update password"})
		return
	}
	// Revoke every active session to invalidate stolen cookies immediately.
	if err := tx.Where("user_id = ?", user.ID).Delete(&UserSession{}).Error; err != nil {
		tx.Rollback()
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to revoke active sessions"})
		return
	}
	if err := tx.Commit().Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to commit password update"})
		return
	}
	// Issue a fresh session for the current device after revocation.
	if err := setAuthenticatedSession(c, user.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Password updated but failed to refresh session"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Password updated"})
}

func handleExportData(c *gin.Context) {
	user := c.MustGet("user").(User)
	var habits []Habit
	db.Where("user_id = ?", user.ID).Find(&habits)
	var logs []HabitLog
	db.Where("user_id = ?", user.ID).Find(&logs)
	c.JSON(http.StatusOK, gin.H{
		"user":   gin.H{"id": user.ID, "username": user.Username, "email": user.Email},
		"habits": habits,
		"logs":   logs,
	})
}

func handleDeleteAccount(c *gin.Context) {
	user := c.MustGet("user").(User)
	var input struct {
		Password string `json:"password" binding:"required"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(input.Password)); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Incorrect password"})
		return
	}

	db.Where("user_id = ?", user.ID).Delete(&HabitLog{})
	db.Where("user_id = ?", user.ID).Delete(&PushSubscription{})
	db.Where("user_id = ?", user.ID).Delete(&StreakFreeze{})
	db.Where("user_id = ?", user.ID).Delete(&UserSession{})
	db.Where("user_id = ?", user.ID).Delete(&Habit{})
	db.Delete(&user)

	if err := clearSession(c); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to clear session"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Account deleted"})
}

// ── E2EE ──────────────────────────────────────────────────────────────────────

func handleE2EEStatus(c *gin.Context) {
	user := c.MustGet("user").(User)
	if !user.E2EEEnabled {
		c.JSON(http.StatusOK, gin.H{"enabled": false})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"enabled":  true,
		"salt":     user.E2EESalt,
		"verifier": user.E2EEVerifier,
	})
}

type e2eeHabitUpdate struct {
	ID    uint   `json:"id"`
	Name  string `json:"name"`
	Notes string `json:"notes"`
}

func handleE2EEEnable(c *gin.Context) {
	user := c.MustGet("user").(User)
	var input struct {
		Salt     string            `json:"salt" binding:"required"`
		Verifier string            `json:"verifier" binding:"required"`
		Habits   []e2eeHabitUpdate `json:"habits"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	tx := db.Begin()
	if tx.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to start E2EE transaction"})
		return
	}
	if err := e2eeBulkUpdateHabits(tx, user.ID, input.Habits); err != nil {
		tx.Rollback()
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	res := tx.Exec(
		"UPDATE users SET e2ee_enabled = true, e2ee_prompt_pending = false, e2ee_salt = ?, e2ee_verifier = ? WHERE id = ?",
		input.Salt,
		input.Verifier,
		user.ID,
	)
	if res.Error != nil {
		tx.Rollback()
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save E2EE settings: " + res.Error.Error()})
		return
	}
	if res.RowsAffected == 0 {
		tx.Rollback()
		c.JSON(http.StatusInternalServerError, gin.H{"error": "E2EE enable matched no rows"})
		return
	}
	if err := tx.Commit().Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to commit E2EE changes"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "E2EE enabled", "enabled": true})
}

func handleE2EEChangePassphrase(c *gin.Context) {
	user := c.MustGet("user").(User)
	var input struct {
		Salt     string            `json:"salt" binding:"required"`
		Verifier string            `json:"verifier" binding:"required"`
		Habits   []e2eeHabitUpdate `json:"habits"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := e2eeBulkUpdateHabits(db, user.ID, input.Habits); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	res := db.Exec(
		"UPDATE users SET e2ee_salt = ?, e2ee_verifier = ? WHERE id = ?",
		input.Salt,
		input.Verifier,
		user.ID,
	)
	if res.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update passphrase: " + res.Error.Error()})
		return
	}
	if res.RowsAffected == 0 {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Passphrase update matched no rows"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Passphrase updated"})
}

func handleE2EEDisable(c *gin.Context) {
	user := c.MustGet("user").(User)
	var input struct {
		Habits []e2eeHabitUpdate `json:"habits"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := e2eeBulkUpdateHabits(db, user.ID, input.Habits); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := db.Exec(
		"UPDATE users SET e2ee_enabled = false, e2ee_prompt_pending = false, e2ee_salt = '', e2ee_verifier = '' WHERE id = ?",
		user.ID,
	).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to disable E2EE"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "E2EE disabled"})
}

func e2eeBulkUpdateHabits(q *gorm.DB, userID string, updates []e2eeHabitUpdate) error {
	for _, u := range updates {
		var habit Habit
		if err := q.Where("id = ? AND user_id = ?", u.ID, userID).First(&habit).Error; err != nil {
			return fmt.Errorf("habit %d not found or not owned by user", u.ID)
		}
		if err := q.Model(&habit).Updates(map[string]any{
			"name":  u.Name,
			"notes": u.Notes,
		}).Error; err != nil {
			return fmt.Errorf("failed to update habit %d: %w", u.ID, err)
		}
	}
	return nil
}

// ── Push Notifications ────────────────────────────────────────────────────────

func handleVapidPublic(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"publicKey": getEnv("VAPID_PUBLIC_KEY", "")})
}

func handlePushSubscribe(c *gin.Context) {
	user := c.MustGet("user").(User)
	var input struct {
		Endpoint    string `json:"endpoint" binding:"required"`
		P256DH      string `json:"p256dh" binding:"required"`
		Auth        string `json:"auth" binding:"required"`
		DeviceLabel string `json:"deviceLabel"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	now := time.Now().UTC()

	var sub PushSubscription
	err := db.Where("user_id = ? AND endpoint = ?", user.ID, input.Endpoint).First(&sub).Error
	if err == nil {
		sub.P256DH = input.P256DH
		sub.Auth = input.Auth
		// Privacy-minimized metadata: rely on user-provided device label.
		sub.UserAgent = ""
		sub.DeviceLabel = strings.TrimSpace(input.DeviceLabel)
		sub.Enabled = true
		sub.LastSeenAt = &now
		if saveErr := db.Save(&sub).Error; saveErr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update subscription"})
			return
		}
		c.JSON(http.StatusCreated, gin.H{"message": "Subscribed"})
		return
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save subscription"})
		return
	}

	sub = PushSubscription{
		UserID:      user.ID,
		Endpoint:    input.Endpoint,
		P256DH:      input.P256DH,
		Auth:        input.Auth,
		UserAgent:   "",
		DeviceLabel: strings.TrimSpace(input.DeviceLabel),
		Enabled:     true,
		LastSeenAt:  &now,
	}
	if createErr := db.Create(&sub).Error; createErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save subscription"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"message": "Subscribed"})
}

func handlePushUnsubscribe(c *gin.Context) {
	user := c.MustGet("user").(User)
	var input struct {
		Endpoint string `json:"endpoint"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}
	input.Endpoint = strings.TrimSpace(input.Endpoint)
	if input.Endpoint == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Endpoint required"})
		return
	}
	db.Where("user_id = ? AND endpoint = ?", user.ID, input.Endpoint).Delete(&PushSubscription{})
	c.JSON(http.StatusOK, gin.H{"message": "Unsubscribed"})
}

func handlePushListSubscriptions(c *gin.Context) {
	user := c.MustGet("user").(User)
	var subs []PushSubscription
	if err := db.Where("user_id = ?", user.ID).Order("created_at desc").Find(&subs).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load subscriptions"})
		return
	}
	c.JSON(http.StatusOK, subs)
}

func handlePushUpdateSubscription(c *gin.Context) {
	user := c.MustGet("user").(User)
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid subscription ID"})
		return
	}
	var input struct {
		Enabled *bool `json:"enabled" binding:"required"`
	}
	if err := c.ShouldBindJSON(&input); err != nil || input.Enabled == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "enabled is required"})
		return
	}

	result := db.Model(&PushSubscription{}).
		Where("id = ? AND user_id = ?", id, user.ID).
		Updates(map[string]any{"enabled": *input.Enabled})
	if result.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update subscription"})
		return
	}
	if result.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "Subscription not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Updated"})
}

func handlePushDeleteSubscription(c *gin.Context) {
	user := c.MustGet("user").(User)
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid subscription ID"})
		return
	}
	result := db.Where("id = ? AND user_id = ?", id, user.ID).Delete(&PushSubscription{})
	if result.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete subscription"})
		return
	}
	if result.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "Subscription not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Deleted"})
}

func handlePushTestSubscription(c *gin.Context) {
	user := c.MustGet("user").(User)
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid subscription ID"})
		return
	}

	var sub PushSubscription
	if err := db.Where("id = ? AND user_id = ?", id, user.ID).First(&sub).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "Subscription not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load subscription"})
		return
	}

	statusCode, sendErr := sendPushAndRecord(sub, "Stokely Test Notification", "If you see this, this device is configured correctly.")
	if sendErr != nil {
		c.JSON(http.StatusBadGateway, gin.H{
			"error":      sendErr.Error(),
			"statusCode": statusCode,
		})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"message":    "Test notification sent",
		"statusCode": statusCode,
	})
}

// ── Session Management ────────────────────────────────────────────────────────

func handleListSessions(c *gin.Context) {
	user := c.MustGet("user").(User)
	currentSID, _ := c.Get("sessionID")

	var userSessions []UserSession
	if err := db.Where("user_id = ?", user.ID).Order("last_seen_at desc").Find(&userSessions).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load sessions"})
		return
	}

	type sessionResp struct {
		UserSession
		IsCurrent bool `json:"isCurrent"`
	}
	result := make([]sessionResp, len(userSessions))
	for i, s := range userSessions {
		result[i] = sessionResp{UserSession: s, IsCurrent: s.ID == currentSID}
	}
	c.JSON(http.StatusOK, result)
}

func handleDeleteSession(c *gin.Context) {
	user := c.MustGet("user").(User)
	targetID := c.Param("id")
	currentSID, _ := c.Get("sessionID")
	if targetID == currentSID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Use logout to end the current session"})
		return
	}
	result := db.Where("id = ? AND user_id = ?", targetID, user.ID).Delete(&UserSession{})
	if result.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to terminate session"})
		return
	}
	if result.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Session terminated"})
}

func handleLogoutOtherSessions(c *gin.Context) {
	user := c.MustGet("user").(User)
	currentSID, _ := c.Get("sessionID")
	q := db.Where("user_id = ?", user.ID)
	if id, ok := currentSID.(string); ok && id != "" {
		q = q.Where("id != ?", id)
	}
	if err := q.Delete(&UserSession{}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to terminate sessions"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "All other sessions terminated"})
}

// ── Email Verification ────────────────────────────────────────────────────────

// queueEmailVerification creates an EmailToken and sends a verification email.
// It replaces any existing pending "verify" token for this user.
func queueEmailVerification(userID, username, email string) error {
	if !smtpConfigured() {
		return fmt.Errorf("SMTP not configured")
	}
	db.Where("user_id = ? AND type = ?", userID, "verify").Delete(&EmailToken{})
	token, err := generateSessionID()
	if err != nil {
		return err
	}
	et := EmailToken{
		Token:     hashEmailToken(token),
		UserID:    userID,
		Email:     strings.ToLower(strings.TrimSpace(email)),
		Type:      "verify",
		ExpiresAt: time.Now().UTC().Add(24 * time.Hour),
	}
	if err := db.Create(&et).Error; err != nil {
		return err
	}
	verifyURL := appURL() + "/verify-email?token=" + token
	if err := sendEmail(email, "Verify your Stokely email address", verifyEmailHTML(username, verifyURL)); err != nil {
		db.Delete(&et)
		return err
	}
	return nil
}

func handleSendVerificationEmail(c *gin.Context) {
	user := c.MustGet("user").(User)
	var input struct {
		Email string `json:"email" binding:"required,email,max=255"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Valid email address required"})
		return
	}
	addr := strings.ToLower(strings.TrimSpace(input.Email))

	// Reject if this is already their verified email.
	if user.Email != nil && strings.EqualFold(*user.Email, addr) && user.EmailVerified {
		c.JSON(http.StatusBadRequest, gin.H{"error": "That email is already verified on your account"})
		return
	}

	// Reject if another verified user already owns this email.
	var existing User
	if err := db.Where("email = ? AND email_verified = true AND id != ?", addr, user.ID).First(&existing).Error; err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "Email already in use"})
		return
	}
	if remaining := emailResendCooldownRemaining(user.ID, "verify", time.Now().UTC()); remaining > 0 {
		secs := cooldownCeilSeconds(remaining)
		c.Header("Retry-After", strconv.Itoa(secs))
		c.JSON(http.StatusTooManyRequests, gin.H{"error": fmt.Sprintf("Please wait %d seconds before requesting another verification email", secs)})
		return
	}

	if err := queueEmailVerification(user.ID, user.Username, addr); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to send verification email: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Verification email sent"})
}

func handleVerifyEmail(c *gin.Context) {
	token := strings.TrimSpace(c.Query("token"))
	if token == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Token required"})
		return
	}

	var et EmailToken
	if err := db.Where("token = ? AND type = ?", hashEmailToken(token), "verify").First(&et).Error; err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid or expired verification link"})
		return
	}
	if time.Now().UTC().After(et.ExpiresAt) {
		db.Delete(&et)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Verification link has expired. Please request a new one."})
		return
	}

	// Check email not already taken by another verified user.
	var conflict User
	if err := db.Where("email = ? AND email_verified = true AND id != ?", et.Email, et.UserID).First(&conflict).Error; err == nil {
		db.Delete(&et)
		c.JSON(http.StatusConflict, gin.H{"error": "Email already in use by another account"})
		return
	}

	if err := db.Model(&User{}).Where("id = ?", et.UserID).
		Updates(map[string]any{"email": et.Email, "email_verified": true}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update email"})
		return
	}
	db.Delete(&et)
	c.JSON(http.StatusOK, gin.H{"message": "Email verified successfully"})
}

func handleRemoveEmail(c *gin.Context) {
	user := c.MustGet("user").(User)
	if user.Email == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No email address on this account"})
		return
	}

	var input struct {
		// Client must explicitly confirm they understand password recovery is lost.
		Confirm bool `json:"confirm" binding:"required"`
	}
	if err := c.ShouldBindJSON(&input); err != nil || !input.Confirm {
		c.JSON(http.StatusBadRequest, gin.H{"error": "confirm must be true"})
		return
	}

	// Delete any pending email/reset tokens for this user.
	db.Where("user_id = ?", user.ID).Delete(&EmailToken{})

	if err := db.Model(&User{}).Where("id = ?", user.ID).
		Updates(map[string]any{"email": nil, "email_verified": false}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to remove email"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Email removed"})
}

// ── Password Reset ────────────────────────────────────────────────────────────

func handleForgotPassword(c *gin.Context) {
	if !checkAuthRateLimit(c) {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "Too many attempts, please try again later"})
		return
	}
	var input struct {
		Username string `json:"username" binding:"required,max=50"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var user User
	if err := db.Where("username = ?", input.Username).First(&user).Error; err != nil {
		c.JSON(http.StatusOK, gin.H{"message": forgotPasswordGenericMessage})
		return
	}
	if user.Email == nil || !user.EmailVerified {
		c.JSON(http.StatusOK, gin.H{"message": forgotPasswordGenericMessage})
		return
	}

	if !smtpConfigured() {
		log.Printf("forgot-password requested for user=%s but SMTP is not configured", user.ID)
		c.JSON(http.StatusOK, gin.H{"message": forgotPasswordGenericMessage})
		return
	}
	if remaining := emailResendCooldownRemaining(user.ID, "reset", time.Now().UTC()); remaining > 0 {
		log.Printf("forgot-password cooldown active for user=%s remaining=%s", user.ID, remaining.String())
		c.JSON(http.StatusOK, gin.H{"message": forgotPasswordGenericMessage})
		return
	}

	// Delete any existing reset token for this user.
	db.Where("user_id = ? AND type = ?", user.ID, "reset").Delete(&EmailToken{})

	token, err := generateSessionID()
	if err != nil {
		log.Printf("forgot-password token generation failed for user=%s: %v", user.ID, err)
		c.JSON(http.StatusOK, gin.H{"message": forgotPasswordGenericMessage})
		return
	}
	et := EmailToken{
		Token:     hashEmailToken(token),
		UserID:    user.ID,
		Email:     *user.Email,
		Type:      "reset",
		ExpiresAt: time.Now().UTC().Add(10 * time.Minute),
	}
	if err := db.Create(&et).Error; err != nil {
		log.Printf("forgot-password token persist failed for user=%s: %v", user.ID, err)
		c.JSON(http.StatusOK, gin.H{"message": forgotPasswordGenericMessage})
		return
	}
	resetURL := appURL() + "/reset-password?token=" + token
	if err := sendEmail(*user.Email, "Reset your Stokely password", resetPasswordHTML(user.Username, resetURL)); err != nil {
		db.Delete(&et)
		log.Printf("forgot-password email send failed for user=%s: %v", user.ID, err)
		c.JSON(http.StatusOK, gin.H{"message": forgotPasswordGenericMessage})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": forgotPasswordGenericMessage})
}

func handleResetPassword(c *gin.Context) {
	if !checkAuthRateLimit(c) {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "Too many attempts, please try again later"})
		return
	}
	var input struct {
		Token       string `json:"token" binding:"required"`
		NewPassword string `json:"newPassword" binding:"required,min=8,max=128"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var et EmailToken
	if err := db.Where("token = ? AND type = ?", hashEmailToken(input.Token), "reset").First(&et).Error; err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid or expired reset link"})
		return
	}
	if time.Now().UTC().After(et.ExpiresAt) {
		db.Delete(&et)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Reset link has expired. Please request a new one."})
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(input.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to process password"})
		return
	}
	if err := db.Model(&User{}).Where("id = ?", et.UserID).
		UpdateColumn("password", string(hash)).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update password"})
		return
	}
	// Invalidate all sessions so old-password cookies stop working.
	db.Where("user_id = ?", et.UserID).Delete(&UserSession{})
	db.Delete(&et)
	c.JSON(http.StatusOK, gin.H{"message": "Password reset successfully"})
}
