package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

const webAuthnRegSessionKey = "webauthn_reg"
const webAuthnLoginSessionKey = "webauthn_login"

var wauthn *webauthn.WebAuthn

func initWebAuthn() {
	rpID := getEnv("WEBAUTHN_RPID", "")
	if rpID == "" {
		log.Println("WEBAUTHN_RPID not set — passkeys disabled")
		return
	}
	originsRaw := getEnv("WEBAUTHN_ORIGINS", getEnv("FRONTEND_ORIGIN", ""))
	var origins []string
	for _, o := range strings.Split(originsRaw, ",") {
		if t := strings.TrimSpace(o); t != "" {
			origins = append(origins, t)
		}
	}
	cfg := &webauthn.Config{
		RPID:          rpID,
		RPDisplayName: "Stokely",
		RPOrigins:     origins,
	}
	var err error
	wauthn, err = webauthn.New(cfg)
	if err != nil {
		log.Printf("WebAuthn init failed (passkeys disabled): %v", err)
	}
}

// passkeyUser wraps User to satisfy webauthn.User interface.
type passkeyUser struct {
	u     User
	creds []webauthn.Credential
}

func (p *passkeyUser) WebAuthnID() []byte                         { return []byte(p.u.ID) }
func (p *passkeyUser) WebAuthnName() string                       { return p.u.Username }
func (p *passkeyUser) WebAuthnDisplayName() string                { return p.u.Username }
func (p *passkeyUser) WebAuthnCredentials() []webauthn.Credential { return p.creds }

func loadPasskeyCredentials(userID string) ([]webauthn.Credential, error) {
	var passkeys []Passkey
	if err := db.Where("user_id = ?", userID).Find(&passkeys).Error; err != nil {
		return nil, err
	}
	creds := make([]webauthn.Credential, 0, len(passkeys))
	for _, pk := range passkeys {
		var c webauthn.Credential
		if err := json.Unmarshal([]byte(pk.CredentialData), &c); err != nil {
			continue
		}
		creds = append(creds, c)
	}
	return creds, nil
}

func countUserPasskeys(userID string) (int64, error) {
	var n int64
	err := db.Model(&Passkey{}).Where("user_id = ?", userID).Count(&n).Error
	return n, err
}

// GET /api/passkeys
func handleListPasskeys(c *gin.Context) {
	user := c.MustGet("user").(User)
	var passkeys []Passkey
	if err := db.Where("user_id = ?", user.ID).Order("created_at desc").Find(&passkeys).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load passkeys"})
		return
	}
	type PasskeyItem struct {
		ID         uint       `json:"id"`
		Name       string     `json:"name"`
		CreatedAt  time.Time  `json:"createdAt"`
		LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
	}
	items := make([]PasskeyItem, len(passkeys))
	for i, pk := range passkeys {
		items[i] = PasskeyItem{ID: pk.ID, Name: pk.Name, CreatedAt: pk.CreatedAt, LastUsedAt: pk.LastUsedAt}
	}
	c.JSON(http.StatusOK, items)
}

// POST /api/passkeys/register/begin
func handlePasskeyRegisterBegin(c *gin.Context) {
	if wauthn == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Passkeys not configured on this server"})
		return
	}
	user := c.MustGet("user").(User)
	creds, err := loadPasskeyCredentials(user.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load credentials"})
		return
	}

	// Request a discoverable credential (passkey) that syncs across devices via
	// iCloud Keychain (Apple), Google Password Manager (Android), or Windows Hello.
	// residentKey=required is the defining property of a passkey vs a plain FIDO2 key.
	options, sessionData, err := wauthn.BeginRegistration(
		&passkeyUser{u: user, creds: creds},
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationPreferred,
		}),
		webauthn.WithConveyancePreference(protocol.PreferNoAttestation),
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to begin registration"})
		return
	}

	sdJSON, err := json.Marshal(sessionData)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Internal error"})
		return
	}
	sess := sessions.Default(c)
	sess.Set(webAuthnRegSessionKey, string(sdJSON))
	if err := sess.Save(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save session"})
		return
	}

	c.JSON(http.StatusOK, options)
}

// POST /api/passkeys/register/finish?name=<label>
func handlePasskeyRegisterFinish(c *gin.Context) {
	if wauthn == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Passkeys not configured on this server"})
		return
	}
	user := c.MustGet("user").(User)

	sess := sessions.Default(c)
	raw := sess.Get(webAuthnRegSessionKey)
	if raw == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No active registration session"})
		return
	}
	sess.Delete(webAuthnRegSessionKey)
	_ = sess.Save()

	var sd webauthn.SessionData
	rawSession, ok := raw.(string)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid session data"})
		return
	}
	if err := json.Unmarshal([]byte(rawSession), &sd); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid session data"})
		return
	}

	creds, err := loadPasskeyCredentials(user.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load credentials"})
		return
	}

	credential, err := wauthn.FinishRegistration(&passkeyUser{u: user, creds: creds}, sd, c.Request)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Registration failed: " + err.Error()})
		return
	}

	credJSON, err := json.Marshal(credential)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Internal error"})
		return
	}

	name := strings.TrimSpace(c.Query("name"))
	if name == "" {
		name = "Passkey"
	}

	pk := Passkey{
		UserID:         user.ID,
		CredentialData: string(credJSON),
		Name:           name,
	}
	if err := db.Create(&pk).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save passkey"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"id": pk.ID, "name": pk.Name})
}

// PUT /api/passkeys/:id
func handleRenamePasskey(c *gin.Context) {
	user := c.MustGet("user").(User)
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid passkey ID"})
		return
	}
	var input struct {
		Name string `json:"name" binding:"required"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Name is required"})
		return
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Name cannot be empty"})
		return
	}
	res := db.Model(&Passkey{}).Where("id = ? AND user_id = ?", uint(id), user.ID).Update("name", name)
	if res.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to rename passkey"})
		return
	}
	if res.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "Passkey not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Renamed"})
}

// DELETE /api/passkeys/:id
func handleDeletePasskey(c *gin.Context) {
	user := c.MustGet("user").(User)
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid passkey ID"})
		return
	}
	res := db.Where("id = ? AND user_id = ?", uint(id), user.ID).Delete(&Passkey{})
	if res.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete passkey"})
		return
	}
	if res.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "Passkey not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Deleted"})
}

// POST /api/passkeys/login/begin (unauthenticated)
func handlePasskeyLoginBegin(c *gin.Context) {
	if wauthn == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Passkeys not configured on this server"})
		return
	}

	options, sessionData, err := wauthn.BeginDiscoverableLogin()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to begin login"})
		return
	}

	sdJSON, err := json.Marshal(sessionData)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Internal error"})
		return
	}
	sess := sessions.Default(c)
	sess.Set(webAuthnLoginSessionKey, string(sdJSON))
	if err := sess.Save(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save session"})
		return
	}

	c.JSON(http.StatusOK, options)
}

// POST /api/passkeys/login/finish (unauthenticated)
func handlePasskeyLoginFinish(c *gin.Context) {
	if wauthn == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Passkeys not configured on this server"})
		return
	}

	// Pull and immediately invalidate the challenge — prevents replay even if verification fails.
	sess := sessions.Default(c)
	raw := sess.Get(webAuthnLoginSessionKey)
	if raw == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No active login session"})
		return
	}
	sess.Delete(webAuthnLoginSessionKey)
	_ = sess.Save()

	var sd webauthn.SessionData
	rawSession, ok := raw.(string)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid session data"})
		return
	}
	if err := json.Unmarshal([]byte(rawSession), &sd); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid session data"})
		return
	}

	// Look up the user by the userHandle embedded in the assertion (our user UUID).
	handler := func(_, userHandle []byte) (webauthn.User, error) {
		userID := string(userHandle)
		if userID == "" {
			return nil, errors.New("empty user handle")
		}
		creds, err := loadPasskeyCredentials(userID)
		if err != nil || len(creds) == 0 {
			return nil, errors.New("user not found")
		}
		var user User
		if err := db.First(&user, "id = ?", userID).Error; err != nil {
			return nil, errors.New("user not found")
		}
		return &passkeyUser{u: user, creds: creds}, nil
	}

	waUser, credential, err := wauthn.FinishPasskeyLogin(handler, sd, c.Request)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Passkey verification failed"})
		return
	}

	user := waUser.(*passkeyUser).u
	updatePasskeyAfterLogin(user.ID, credential)

	if err := setAuthenticatedSession(c, user.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create session"})
		return
	}

	// Reload user after consumeE2EESetupPrompt may have written to DB.
	var freshUser User
	if err := db.First(&freshUser, "id = ?", user.ID).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load user"})
		return
	}
	showWelcome := isWelcomePending(&freshUser)
	e2eeSetupPrompt := consumeE2EESetupPrompt(&freshUser)
	passkeyCount, _ := countUserPasskeys(freshUser.ID)

	c.JSON(http.StatusOK, gin.H{
		"id":                freshUser.ID,
		"username":          freshUser.Username,
		"email":             freshUser.Email,
		"emailVerified":     freshUser.EmailVerified,
		"showWelcome":       showWelcome,
		"dailySparkEnabled": freshUser.DailySparkEnabled,
		"e2eeEnabled":       freshUser.E2EEEnabled,
		"e2eeSetupPrompt":   e2eeSetupPrompt,
		"hasPasskeys":       passkeyCount > 0,
	})
}

// updatePasskeyAfterLogin bumps the sign counter and records the last-used time.
func updatePasskeyAfterLogin(userID string, credential *webauthn.Credential) {
	if credential == nil {
		return
	}
	var passkeys []Passkey
	if err := db.Where("user_id = ?", userID).Find(&passkeys).Error; err != nil {
		return
	}
	for i, pk := range passkeys {
		var c webauthn.Credential
		if err := json.Unmarshal([]byte(pk.CredentialData), &c); err != nil {
			continue
		}
		if string(c.ID) != string(credential.ID) {
			continue
		}
		updatedJSON, err := json.Marshal(credential)
		if err != nil {
			return
		}
		now := time.Now().UTC()
		db.Model(&passkeys[i]).Updates(map[string]interface{}{
			"credential_data": string(updatedJSON),
			"last_used_at":    now,
		})
		return
	}
}
