package main

import "time"

type User struct {
	ID                string    `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	CreatedAt         time.Time `json:"-"`
	Username          string    `gorm:"type:varchar(50);uniqueIndex;not null" json:"username"`
	Email             *string   `gorm:"type:varchar(255);uniqueIndex" json:"email,omitempty"`
	EmailVerified     bool      `gorm:"default:false" json:"-"`
	Password          string    `gorm:"type:varchar(255);not null" json:"-"`
	WelcomeSeen       bool      `gorm:"default:false" json:"-"`
	DailySparkEnabled bool      `gorm:"default:true" json:"-"`
	E2EEEnabled       bool      `gorm:"column:e2ee_enabled;default:false" json:"e2eeEnabled"`
	E2EEPromptPending bool      `gorm:"column:e2ee_prompt_pending;default:true" json:"-"`
	E2EESalt          string    `gorm:"column:e2ee_salt;type:varchar(64);default:''" json:"-"`
	E2EEVerifier      string    `gorm:"column:e2ee_verifier;type:varchar(512);default:''" json:"-"`
}

type Habit struct {
	ID            uint       `gorm:"primaryKey" json:"id"`
	CreatedAt     time.Time  `json:"createdAt"`
	UserID        string     `gorm:"type:uuid;not null;index" json:"-"`
	Name          string     `gorm:"type:text;not null" json:"name"`
	Complete      bool       `json:"-"` // deprecated: completion now tracked via HabitLog
	Recurrence    string     `gorm:"type:varchar(100);not null" json:"recurrence"`
	PositiveType  bool       `json:"positiveType"`
	Icon          string     `gorm:"type:varchar(100);default:''" json:"icon"`
	RecurrenceEnd *time.Time `json:"recurrenceEnd,omitempty"`
	Notes         string     `gorm:"type:text;default:''" json:"notes"`
	ReminderTime  string     `gorm:"type:varchar(5);default:''" json:"reminderTime"`
	ReminderTZ    string     `gorm:"type:varchar(64);default:''" json:"reminderTz,omitempty"`
}

// HabitResponse is returned by all habit API endpoints, including computed fields.
type HabitResponse struct {
	ID            uint       `json:"id"`
	CreatedAt     time.Time  `json:"createdAt"`
	Name          string     `json:"name"`
	Complete      bool       `json:"complete"`
	Recurrence    string     `json:"recurrence"`
	PositiveType  bool       `json:"positiveType"`
	Icon          string     `json:"icon"`
	RecurrenceEnd *time.Time `json:"recurrenceEnd,omitempty"`
	Notes         string     `json:"notes"`
	ReminderTime  string     `json:"reminderTime"`
	ReminderTZ    string     `json:"reminderTz,omitempty"`
	Streak        int        `json:"streak"`
	HasFreeze     bool       `json:"hasFreeze"`
	FrozenToday   bool       `json:"frozenToday"`
}

// HabitLog records one completion of a habit on a specific calendar date.
// WasFrozen = true means a streak freeze was consumed for this day (not a real completion).
type HabitLog struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	CreatedAt time.Time `json:"-"`
	HabitID   uint      `gorm:"not null;uniqueIndex:idx_habit_log" json:"habitId"`
	UserID    string    `gorm:"type:uuid;not null;index;uniqueIndex:idx_habit_log;index:idx_hl_user_date,composite:user_id" json:"-"`
	LogDate   time.Time `gorm:"type:date;not null;uniqueIndex:idx_habit_log;index:idx_hl_user_date,composite:log_date" json:"logDate"`
	WasFrozen bool      `gorm:"default:false" json:"wasFrozen"`
}

type PushSubscription struct {
	ID              uint       `gorm:"primaryKey" json:"id"`
	CreatedAt       time.Time  `json:"createdAt"`
	UserID          string     `gorm:"type:uuid;not null;uniqueIndex:idx_push_user_endpoint" json:"-"`
	Endpoint        string     `gorm:"type:text;not null;uniqueIndex:idx_push_user_endpoint" json:"endpoint"`
	P256DH          string     `gorm:"type:text;not null" json:"-"`
	Auth            string     `gorm:"type:text;not null" json:"-"`
	UserAgent       string     `gorm:"type:text;default:''" json:"userAgent"`
	DeviceLabel     string     `gorm:"type:varchar(120);default:''" json:"deviceLabel"`
	Enabled         bool       `gorm:"default:true" json:"enabled"`
	LastSeenAt      *time.Time `json:"lastSeenAt,omitempty"`
	LastSuccessAt   *time.Time `json:"lastSuccessAt,omitempty"`
	LastFailureAt   *time.Time `json:"lastFailureAt,omitempty"`
	LastFailureCode int        `gorm:"default:0" json:"lastFailureCode"`
	FailureCount    int        `gorm:"default:0" json:"failureCount"`
}

type StreakFreeze struct {
	ID     uint   `gorm:"primaryKey" json:"-"`
	UserID string `gorm:"type:uuid;not null;uniqueIndex" json:"-"`
	Count  int    `gorm:"default:0" json:"count"`
}

// EmailToken stores pending email verifications and password reset requests.
type EmailToken struct {
	Token     string    `gorm:"type:varchar(64);primaryKey"`
	UserID    string    `gorm:"type:uuid;not null;index"`
	Email     string    `gorm:"type:varchar(255);not null"` // email being verified or user's email for reset
	Type      string    `gorm:"type:varchar(16);not null"`  // "verify" or "reset"
	ExpiresAt time.Time `gorm:"not null"`
	CreatedAt time.Time
}

// UserSession tracks active login sessions server-side so they can be listed and revoked.
type UserSession struct {
	ID         string    `gorm:"type:varchar(64);primaryKey" json:"id"`
	UserID     string    `gorm:"type:uuid;not null;index" json:"-"`
	CreatedAt  time.Time `json:"createdAt"`
	LastSeenAt time.Time `json:"lastSeenAt"`
	UserAgent  string    `gorm:"type:text;default:''" json:"userAgent"`
	IPAddress  string    `gorm:"type:varchar(64);default:''" json:"ipAddress"`
}

// Passkey stores a WebAuthn credential registered by a user.
type Passkey struct {
	ID             uint       `gorm:"primaryKey" json:"id"`
	CreatedAt      time.Time  `json:"createdAt"`
	UserID         string     `gorm:"type:uuid;not null;index" json:"-"`
	CredentialData string     `gorm:"type:text;not null" json:"-"` // JSON-encoded webauthn.Credential
	Name           string     `gorm:"type:varchar(120);default:'Passkey'" json:"name"`
	LastUsedAt     *time.Time `json:"lastUsedAt,omitempty"`
}
