package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-contrib/sessions"
	"github.com/gin-contrib/sessions/cookie"
	"github.com/gin-gonic/gin"
)

func TestIsValidRecurrence(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		in   string
		want bool
	}{
		{name: "daily", in: "Su-Mo-Tu-We-Th-Fr-Sa", want: true},
		{name: "weekday", in: "Mo-Tu-We-Th-Fr", want: true},
		{name: "single day", in: "Su", want: true},
		{name: "duplicate day", in: "Mo-Mo", want: false},
		{name: "invalid token", in: "Mon-Tu", want: false},
		{name: "too many days", in: "Su-Mo-Tu-We-Th-Fr-Sa-Su", want: false},
		{name: "empty", in: "", want: false},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := isValidRecurrence(tc.in); got != tc.want {
				t.Fatalf("isValidRecurrence(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestIsValidReminderTime(t *testing.T) {
	t.Parallel()

	cases := []struct {
		in   string
		want bool
	}{
		{in: "", want: true},
		{in: "00:00", want: true},
		{in: "23:59", want: true},
		{in: "24:00", want: false},
		{in: "9:00", want: false},
		{in: "12:60", want: false},
	}

	for _, tc := range cases {
		if got := isValidReminderTime(tc.in); got != tc.want {
			t.Fatalf("isValidReminderTime(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestIsValidTimeZone(t *testing.T) {
	t.Parallel()

	if !isValidTimeZone("") {
		t.Fatal("empty timezone should be valid")
	}
	if !isValidTimeZone("America/Toronto") {
		t.Fatal("expected America/Toronto to be valid")
	}
	if isValidTimeZone("Not/A-Real-TZ") {
		t.Fatal("expected invalid timezone to fail")
	}
}

func TestIsValidE2EEHabitPayload(t *testing.T) {
	t.Parallel()

	if !isValidE2EEHabitPayload("e2ee:v1:abc", "") {
		t.Fatal("expected encrypted name + empty notes to be valid")
	}
	if !isValidE2EEHabitPayload("e2ee:v1:abc", "e2ee:v1:def") {
		t.Fatal("expected encrypted name + encrypted notes to be valid")
	}
	if isValidE2EEHabitPayload("Plain", "") {
		t.Fatal("expected plaintext name to be invalid")
	}
	if isValidE2EEHabitPayload("e2ee:v1:abc", "plain note") {
		t.Fatal("expected plaintext notes to be invalid when non-empty")
	}
}

func TestIsValidE2EEHabitMutation(t *testing.T) {
	t.Parallel()

	encryptedName := "e2ee:v1:name"
	encryptedNotes := "e2ee:v1:notes"
	plainName := "Read 20 pages"
	plainNotes := "Personal note"

	if !isValidE2EEHabitMutation(encryptedName, encryptedNotes, nil, nil) {
		t.Fatal("unchanged encrypted habit should be valid")
	}
	if !isValidE2EEHabitMutation(encryptedName, encryptedNotes, &encryptedName, nil) {
		t.Fatal("encrypted name update should be valid")
	}
	if isValidE2EEHabitMutation(encryptedName, encryptedNotes, &plainName, nil) {
		t.Fatal("plaintext name update should be invalid")
	}
	if isValidE2EEHabitMutation(encryptedName, encryptedNotes, nil, &plainNotes) {
		t.Fatal("plaintext notes update should be invalid")
	}
	if isValidE2EEHabitMutation(plainName, "", nil, nil) {
		t.Fatal("existing plaintext habit should be invalid while E2EE is enabled")
	}
}

func TestValidateEncryptedHabitUpdates(t *testing.T) {
	t.Parallel()

	if err := validateEncryptedHabitUpdates([]e2eeHabitUpdate{
		{ID: 1, Name: "e2ee:v1:name", Notes: ""},
		{ID: 2, Name: "e2ee:v1:name2", Notes: "e2ee:v1:notes"},
	}); err != nil {
		t.Fatalf("encrypted updates returned unexpected error: %v", err)
	}

	if err := validateEncryptedHabitUpdates([]e2eeHabitUpdate{
		{ID: 3, Name: "Plain", Notes: "e2ee:v1:notes"},
	}); err == nil {
		t.Fatal("plaintext name update should fail validation")
	}

	if err := validateEncryptedHabitUpdates([]e2eeHabitUpdate{
		{ID: 4, Name: "e2ee:v1:name", Notes: "plain notes"},
	}); err == nil {
		t.Fatal("plaintext notes update should fail validation")
	}
}

func TestDayCodeAndContainsDay(t *testing.T) {
	t.Parallel()

	d := time.Date(2026, 3, 12, 15, 0, 0, 0, time.FixedZone("UTC-5", -5*3600)) // Thursday in UTC too
	if got := dayCode(d); got != "Th" {
		t.Fatalf("dayCode() = %q, want %q", got, "Th")
	}
	if !containsDay("Mo-We-Th", "Th") {
		t.Fatal("containsDay should have matched Th")
	}
	if containsDay("Mo-We-Fr", "Th") {
		t.Fatal("containsDay should not have matched Th")
	}
}

func TestParseDateOrToday(t *testing.T) {
	t.Parallel()

	got, err := parseDateOrToday("2026-03-12")
	if err != nil {
		t.Fatalf("parseDateOrToday returned unexpected error: %v", err)
	}
	want := time.Date(2026, 3, 12, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("parseDateOrToday = %v, want %v", got, want)
	}

	if _, err := parseDateOrToday("2026/03/12"); err == nil {
		t.Fatal("parseDateOrToday should fail on invalid format")
	}

	gotToday, err := parseDateOrToday("")
	if err != nil {
		t.Fatalf("parseDateOrToday empty returned unexpected error: %v", err)
	}
	if gotToday.Location() != time.UTC || gotToday.Hour() != 0 || gotToday.Minute() != 0 {
		t.Fatalf("parseDateOrToday empty should return UTC midnight, got %v", gotToday)
	}
}

func TestHashEmailToken(t *testing.T) {
	t.Parallel()

	a := hashEmailToken("abc")
	b := hashEmailToken("abc")
	c := hashEmailToken("abcd")

	if a != b {
		t.Fatal("hashEmailToken must be deterministic")
	}
	if a == c {
		t.Fatal("hashEmailToken should differ for different inputs")
	}
	if len(a) != 64 {
		t.Fatalf("hashEmailToken length = %d, want 64", len(a))
	}
}

func TestStreakFromLoggedDatesSkipsMissingToday(t *testing.T) {
	t.Parallel()

	habit := Habit{Recurrence: "Su-Mo-Tu-We-Th-Fr-Sa"}
	today := time.Date(2026, 3, 12, 0, 0, 0, 0, time.UTC)
	windowStart := today.AddDate(0, 0, -90)
	loggedDates := map[string]bool{
		"2026-03-11": true,
		"2026-03-10": true,
	}

	got := streakFromLoggedDates(habit, loggedDates, today, windowStart)
	if got != 2 {
		t.Fatalf("streakFromLoggedDates = %d, want 2", got)
	}
}

func TestCooldownCeilSeconds(t *testing.T) {
	t.Parallel()

	cases := []struct {
		in   time.Duration
		want int
	}{
		{in: 0, want: 0},
		{in: 200 * time.Millisecond, want: 1},
		{in: 1 * time.Second, want: 1},
		{in: 1500 * time.Millisecond, want: 2},
		{in: 59 * time.Second, want: 59},
	}
	for _, tc := range cases {
		if got := cooldownCeilSeconds(tc.in); got != tc.want {
			t.Fatalf("cooldownCeilSeconds(%v) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

func TestResendCooldownRemaining(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 3, 13, 12, 0, 0, 0, time.UTC)
	last := now.Add(-30 * time.Second)
	if got := resendCooldownRemaining(last, now); got != 30*time.Second {
		t.Fatalf("resendCooldownRemaining = %v, want %v", got, 30*time.Second)
	}

	lastOld := now.Add(-2 * time.Minute)
	if got := resendCooldownRemaining(lastOld, now); got != 0 {
		t.Fatalf("resendCooldownRemaining for old token = %v, want 0", got)
	}
}

func TestLongestStreakEver(t *testing.T) {
	t.Parallel()

	habit := Habit{
		CreatedAt:  time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC),
		Recurrence: "Su-Mo-Tu-We-Th-Fr-Sa",
	}
	logs := []HabitLog{
		{LogDate: time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)},
		{LogDate: time.Date(2026, 3, 2, 0, 0, 0, 0, time.UTC)},
		{LogDate: time.Date(2026, 3, 3, 0, 0, 0, 0, time.UTC)},
		{LogDate: time.Date(2026, 3, 5, 0, 0, 0, 0, time.UTC)},
		{LogDate: time.Date(2026, 3, 6, 0, 0, 0, 0, time.UTC)},
	}
	if got := longestStreakEver(habit, logs); got != 3 {
		t.Fatalf("longestStreakEver = %d, want 3", got)
	}
}

func TestGenerateTokens(t *testing.T) {
	t.Parallel()

	csrfToken, err := generateCSRFToken()
	if err != nil {
		t.Fatalf("generateCSRFToken returned error: %v", err)
	}
	sessionID, err := generateSessionID()
	if err != nil {
		t.Fatalf("generateSessionID returned error: %v", err)
	}
	if len(csrfToken) < 40 {
		t.Fatalf("generateCSRFToken too short: %d", len(csrfToken))
	}
	if len(sessionID) < 30 {
		t.Fatalf("generateSessionID too short: %d", len(sessionID))
	}
}

func TestRequireCSRFMiddleware(t *testing.T) {
	t.Parallel()
	gin.SetMode(gin.TestMode)

	makeRouter := func(sessionToken string, headerToken string) *gin.Engine {
		r := gin.New()
		store := cookie.NewStore([]byte("test-secret"))
		r.Use(sessions.Sessions("test-session", store))
		r.POST("/", func(c *gin.Context) {
			if sessionToken != "" {
				s := sessions.Default(c)
				s.Set("csrfToken", sessionToken)
				_ = s.Save()
			}
			if headerToken != "" {
				c.Request.Header.Set("X-CSRF-Token", headerToken)
			}
			requireCSRF(c)
			if c.IsAborted() {
				return
			}
			c.Status(http.StatusNoContent)
		})
		r.GET("/", func(c *gin.Context) {
			requireCSRF(c)
			if c.IsAborted() {
				return
			}
			c.Status(http.StatusNoContent)
		})
		return r
	}

	t.Run("safe method bypasses csrf", func(t *testing.T) {
		r := makeRouter("", "")
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		r.ServeHTTP(w, req)
		if w.Code != http.StatusNoContent {
			t.Fatalf("GET status = %d, want %d", w.Code, http.StatusNoContent)
		}
	})

	t.Run("missing csrf in session rejected", func(t *testing.T) {
		r := makeRouter("", "")
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{}`))
		r.ServeHTTP(w, req)
		if w.Code != http.StatusForbidden {
			t.Fatalf("POST status = %d, want %d", w.Code, http.StatusForbidden)
		}
		if !strings.Contains(w.Body.String(), "CSRF token missing") {
			t.Fatalf("response = %q, expected csrf missing message", w.Body.String())
		}
	})

	t.Run("mismatched csrf header rejected", func(t *testing.T) {
		r := makeRouter("token-1", "token-2")
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{}`))
		r.ServeHTTP(w, req)
		if w.Code != http.StatusForbidden {
			t.Fatalf("POST status = %d, want %d", w.Code, http.StatusForbidden)
		}
		if !strings.Contains(w.Body.String(), "Invalid CSRF token") {
			t.Fatalf("response = %q, expected invalid csrf message", w.Body.String())
		}
	})

	t.Run("matching csrf header accepted", func(t *testing.T) {
		r := makeRouter("same-token", "same-token")
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{}`))
		r.ServeHTTP(w, req)
		if w.Code != http.StatusNoContent {
			t.Fatalf("POST status = %d, want %d", w.Code, http.StatusNoContent)
		}
	})
}

func TestCheckAuthRateLimit(t *testing.T) {
	t.Parallel()
	gin.SetMode(gin.TestMode)

	authLimitMap = sync.Map{}
	authLimiterJanitorOnce = sync.Once{}

	r := gin.New()
	r.GET("/", func(c *gin.Context) {
		if checkAuthRateLimit(c) {
			c.Status(http.StatusOK)
			return
		}
		c.Status(http.StatusTooManyRequests)
	})

	for i := 0; i < authRateMax; i++ {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "203.0.113.1:12345"
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("request %d status = %d, want %d", i+1, w.Code, http.StatusOK)
		}
	}

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "203.0.113.1:12345"
	r.ServeHTTP(w, req)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("request %d status = %d, want %d", authRateMax+1, w.Code, http.StatusTooManyRequests)
	}
}

func TestRecordLoginFailureLocksAccount(t *testing.T) {
	loginIPLimitMap = sync.Map{}
	loginAccountLimitMap = sync.Map{}
	loginLimiterJanitorOnce = sync.Once{}

	now := time.Date(2026, 3, 13, 12, 0, 0, 0, time.UTC)
	ip := "198.51.100.10"
	username := "DemoUser"

	var remaining time.Duration
	for i := 0; i < loginAccountMaxFailures; i++ {
		remaining = recordLoginFailure(ip, username, now)
	}
	if remaining <= 0 {
		t.Fatalf("expected account lockout after %d failures", loginAccountMaxFailures)
	}
	if got := loginLockoutRemaining(ip, username, now); got <= 0 {
		t.Fatalf("expected login lockout remaining > 0, got %v", got)
	}
}

func TestRecordLoginFailureLocksIP(t *testing.T) {
	loginIPLimitMap = sync.Map{}
	loginAccountLimitMap = sync.Map{}
	loginLimiterJanitorOnce = sync.Once{}

	now := time.Date(2026, 3, 13, 12, 0, 0, 0, time.UTC)
	ip := "198.51.100.11"

	var remaining time.Duration
	for i := 0; i < loginIPMaxFailures; i++ {
		remaining = recordLoginFailure(ip, "user"+strconv.Itoa(i), now)
	}
	if remaining <= 0 {
		t.Fatalf("expected ip lockout after %d failures", loginIPMaxFailures)
	}
	if got := loginLockoutRemaining(ip, "any-user", now); got <= 0 {
		t.Fatalf("expected ip lockout remaining > 0, got %v", got)
	}
}

func TestClearLoginFailures(t *testing.T) {
	loginIPLimitMap = sync.Map{}
	loginAccountLimitMap = sync.Map{}
	loginLimiterJanitorOnce = sync.Once{}

	now := time.Date(2026, 3, 13, 12, 0, 0, 0, time.UTC)
	ip := "198.51.100.12"
	username := "clearme"

	for i := 0; i < loginAccountMaxFailures; i++ {
		recordLoginFailure(ip, username, now)
	}
	if got := loginLockoutRemaining(ip, username, now); got <= 0 {
		t.Fatalf("expected lockout before clear, got %v", got)
	}

	clearLoginFailures(ip, username)
	if got := loginLockoutRemaining(ip, username, now); got != 0 {
		t.Fatalf("expected lockout to be cleared, got %v", got)
	}
}

func TestCreateHabitRejectsPlaintextWhenE2EEEnabled(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := gin.New()
	r.POST("/habits", func(c *gin.Context) {
		c.Set("user", User{ID: "user-1", E2EEEnabled: true})
		createHabit(c)
	})

	body := map[string]any{
		"name":         "Read 20 pages",
		"recurrence":   "Su-Mo-Tu-We-Th-Fr-Sa",
		"positiveType": true,
		"notes":        "",
		"reminderTime": "",
		"reminderTz":   "America/Toronto",
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("failed to marshal request body: %v", err)
	}

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/habits", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusLocked {
		t.Fatalf("status = %d, want %d; body=%s", w.Code, http.StatusLocked, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "Vault is locked") {
		t.Fatalf("expected vault locked error, got: %s", w.Body.String())
	}
}
