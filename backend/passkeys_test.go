package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-contrib/sessions"
	"github.com/gin-contrib/sessions/cookie"
	"github.com/gin-gonic/gin"
	"github.com/go-webauthn/webauthn/webauthn"
)

func init() {
	gin.SetMode(gin.TestMode)
}

// passkeyTestRouter builds a minimal Gin engine with session middleware and the
// provided handler registered at POST /test.
func passkeyTestRouter(handler gin.HandlerFunc) *gin.Engine {
	r := gin.New()
	store := cookie.NewStore([]byte("test-secret-32-bytes-minimum-len"))
	r.Use(sessions.Sessions("test-session", store))
	r.POST("/test", handler)
	return r
}

// -- wauthn-nil guards ----------------------------------------------------------

func TestHandlePasskeyRegisterBegin_NilWebAuthn(t *testing.T) {
	saved := wauthn
	wauthn = nil
	t.Cleanup(func() { wauthn = saved })

	r := passkeyTestRouter(handlePasskeyRegisterBegin)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/test", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", w.Code)
	}
	if !strings.Contains(w.Body.String(), "not configured") {
		t.Fatalf("body = %q, want 'not configured'", w.Body.String())
	}
}

func TestHandlePasskeyRegisterFinish_NilWebAuthn(t *testing.T) {
	saved := wauthn
	wauthn = nil
	t.Cleanup(func() { wauthn = saved })

	r := passkeyTestRouter(handlePasskeyRegisterFinish)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/test", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", w.Code)
	}
}

func TestHandlePasskeyLoginBegin_NilWebAuthn(t *testing.T) {
	saved := wauthn
	wauthn = nil
	t.Cleanup(func() { wauthn = saved })

	r := passkeyTestRouter(handlePasskeyLoginBegin)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/test", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", w.Code)
	}
}

func TestHandlePasskeyLoginFinish_NilWebAuthn(t *testing.T) {
	saved := wauthn
	wauthn = nil
	t.Cleanup(func() { wauthn = saved })

	r := passkeyTestRouter(handlePasskeyLoginFinish)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/test", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", w.Code)
	}
}

// -- missing-session guards -----------------------------------------------------

func TestHandlePasskeyRegisterFinish_NoSession(t *testing.T) {
	saved := wauthn
	wauthn = &webauthn.WebAuthn{} // non-nil so we reach the session check
	t.Cleanup(func() { wauthn = saved })

	// handlePasskeyRegisterFinish calls c.MustGet("user") before the session
	// check, so we must inject a user into the context.
	r := gin.New()
	store := cookie.NewStore([]byte("test-secret-32-bytes-minimum-len"))
	r.Use(sessions.Sessions("test-session", store))
	r.POST("/test", func(c *gin.Context) {
		c.Set("user", User{ID: "user-1", Username: "testuser"})
		handlePasskeyRegisterFinish(c)
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/test", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "No active registration session") {
		t.Fatalf("body = %q, expected session error", w.Body.String())
	}
}

func TestHandlePasskeyLoginFinish_NoSession(t *testing.T) {
	saved := wauthn
	wauthn = &webauthn.WebAuthn{}
	t.Cleanup(func() { wauthn = saved })

	r := passkeyTestRouter(handlePasskeyLoginFinish)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/test", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "No active login session") {
		t.Fatalf("body = %q, expected session error", w.Body.String())
	}
}

// -- invalid session data -------------------------------------------------------

func TestHandlePasskeyRegisterFinish_CorruptSession(t *testing.T) {
	saved := wauthn
	wauthn = &webauthn.WebAuthn{}
	t.Cleanup(func() { wauthn = saved })

	r := gin.New()
	store := cookie.NewStore([]byte("test-secret-32-bytes-minimum-len"))
	r.Use(sessions.Sessions("test-session", store))

	var sessionCookie string
	r.POST("/seed", func(c *gin.Context) {
		s := sessions.Default(c)
		s.Set(webAuthnRegSessionKey, "not-valid-json")
		_ = s.Save()
		c.Status(http.StatusNoContent)
	})
	r.POST("/test", func(c *gin.Context) {
		c.Set("user", User{ID: "user-1", Username: "testuser"})
		handlePasskeyRegisterFinish(c)
	})

	// Seed
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/seed", nil))
	sessionCookie = w.Header().Get("Set-Cookie")

	// Finish with the seeded session
	w2 := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/test", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	if sessionCookie != "" {
		req.Header.Set("Cookie", sessionCookie)
	}
	r.ServeHTTP(w2, req)

	if w2.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w2.Code)
	}
	if !strings.Contains(w2.Body.String(), "Invalid session data") {
		t.Fatalf("body = %q, expected invalid session error", w2.Body.String())
	}
}

func TestHandlePasskeyRegisterFinish_NonStringSession(t *testing.T) {
	saved := wauthn
	wauthn = &webauthn.WebAuthn{}
	t.Cleanup(func() { wauthn = saved })

	r := gin.New()
	store := cookie.NewStore([]byte("test-secret-32-bytes-minimum-len"))
	r.Use(sessions.Sessions("test-session", store))

	r.POST("/seed", func(c *gin.Context) {
		s := sessions.Default(c)
		s.Set(webAuthnRegSessionKey, 42)
		_ = s.Save()
		c.Status(http.StatusNoContent)
	})
	r.POST("/test", func(c *gin.Context) {
		c.Set("user", User{ID: "user-1", Username: "testuser"})
		handlePasskeyRegisterFinish(c)
	})

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/seed", nil))

	w2 := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/test", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", w.Header().Get("Set-Cookie"))
	r.ServeHTTP(w2, req)

	if w2.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w2.Code)
	}
	if !strings.Contains(w2.Body.String(), "Invalid session data") {
		t.Fatalf("body = %q, expected invalid session error", w2.Body.String())
	}
}

func TestHandlePasskeyLoginFinish_CorruptSession(t *testing.T) {
	saved := wauthn
	wauthn = &webauthn.WebAuthn{}
	t.Cleanup(func() { wauthn = saved })

	r := gin.New()
	store := cookie.NewStore([]byte("test-secret-32-bytes-minimum-len"))
	r.Use(sessions.Sessions("test-session", store))

	r.POST("/seed", func(c *gin.Context) {
		s := sessions.Default(c)
		s.Set(webAuthnLoginSessionKey, "not-valid-json")
		_ = s.Save()
		c.Status(http.StatusNoContent)
	})
	r.POST("/test", handlePasskeyLoginFinish)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/seed", nil))

	w2 := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/test", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", w.Header().Get("Set-Cookie"))
	r.ServeHTTP(w2, req)

	if w2.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w2.Code)
	}
	if !strings.Contains(w2.Body.String(), "Invalid session data") {
		t.Fatalf("body = %q, expected invalid session error", w2.Body.String())
	}
}

func TestHandlePasskeyLoginFinish_NonStringSession(t *testing.T) {
	saved := wauthn
	wauthn = &webauthn.WebAuthn{}
	t.Cleanup(func() { wauthn = saved })

	r := gin.New()
	store := cookie.NewStore([]byte("test-secret-32-bytes-minimum-len"))
	r.Use(sessions.Sessions("test-session", store))

	r.POST("/seed", func(c *gin.Context) {
		s := sessions.Default(c)
		s.Set(webAuthnLoginSessionKey, 42)
		_ = s.Save()
		c.Status(http.StatusNoContent)
	})
	r.POST("/test", handlePasskeyLoginFinish)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/seed", nil))

	w2 := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/test", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", w.Header().Get("Set-Cookie"))
	r.ServeHTTP(w2, req)

	if w2.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w2.Code)
	}
	if !strings.Contains(w2.Body.String(), "Invalid session data") {
		t.Fatalf("body = %q, expected invalid session error", w2.Body.String())
	}
}

// -- rename validation ----------------------------------------------------------

func TestHandleRenamePasskey_InvalidID(t *testing.T) {
	t.Parallel()

	r := gin.New()
	store := cookie.NewStore([]byte("test-secret-32-bytes-minimum-len"))
	r.Use(sessions.Sessions("test-session", store))
	r.PUT("/:id", func(c *gin.Context) {
		c.Set("user", User{ID: "user-1", Username: "test"})
		handleRenamePasskey(c)
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/not-a-number", strings.NewReader(`{"name":"My Key"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestHandleRenamePasskey_EmptyName(t *testing.T) {
	t.Parallel()

	r := gin.New()
	store := cookie.NewStore([]byte("test-secret-32-bytes-minimum-len"))
	r.Use(sessions.Sessions("test-session", store))
	r.PUT("/:id", func(c *gin.Context) {
		c.Set("user", User{ID: "user-1", Username: "test"})
		handleRenamePasskey(c)
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/42", strings.NewReader(`{"name":"   "}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body: %s", w.Code, w.Body.String())
	}
}

// -- delete validation ----------------------------------------------------------

func TestHandleDeletePasskey_InvalidID(t *testing.T) {
	t.Parallel()

	r := gin.New()
	store := cookie.NewStore([]byte("test-secret-32-bytes-minimum-len"))
	r.Use(sessions.Sessions("test-session", store))
	r.DELETE("/:id", func(c *gin.Context) {
		c.Set("user", User{ID: "user-1", Username: "test"})
		handleDeletePasskey(c)
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, "/bad-id", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

// -- updatePasskeyAfterLogin ----------------------------------------------------

func TestUpdatePasskeyAfterLogin_NilCredential(t *testing.T) {
	t.Parallel()
	// Must not panic when credential is nil.
	updatePasskeyAfterLogin("user-1", nil)
}

// -- initWebAuthn ---------------------------------------------------------------

func TestInitWebAuthn_NoEnvVars(t *testing.T) {
	saved := wauthn
	t.Cleanup(func() { wauthn = saved })
	t.Setenv("WEBAUTHN_RPID", "")

	// With no WEBAUTHN_RPID set, initWebAuthn leaves wauthn nil.
	wauthn = nil
	initWebAuthn()
	if wauthn != nil {
		t.Fatal("expected wauthn to remain nil when WEBAUTHN_RPID is not set")
	}
}

func TestInitWebAuthn_Configured(t *testing.T) {
	saved := wauthn
	t.Cleanup(func() { wauthn = saved })
	t.Setenv("WEBAUTHN_RPID", "localhost")
	t.Setenv("WEBAUTHN_ORIGINS", "http://localhost:5173, https://app.example.test")

	wauthn = nil
	initWebAuthn()
	if wauthn == nil {
		t.Fatal("expected wauthn to be configured when RPID and origins are set")
	}
}

// -- session key constants ------------------------------------------------------

func TestWebAuthnSessionKeyConstants(t *testing.T) {
	t.Parallel()

	if webAuthnRegSessionKey == webAuthnLoginSessionKey {
		t.Fatal("registration and login session keys must be distinct to prevent cross-ceremony confusion")
	}
	if webAuthnRegSessionKey == "" || webAuthnLoginSessionKey == "" {
		t.Fatal("session key constants must not be empty")
	}
}
