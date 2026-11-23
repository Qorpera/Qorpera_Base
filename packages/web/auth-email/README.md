# Sign-in emails

The login service (Supabase Auth → Emails) sends these. Paste each file into its template and set its subject:

| File | Template | Subject |
| --- | --- | --- |
| `confirm-signup.html` | Confirm signup | `{{ .Token }} is your Qorpera code` |
| `magic-link.html` | Magic link | `{{ .Token }} is your Qorpera sign-in code` |
| `reset-password.html` | Reset password | `Reset your Qorpera password` |
| `password-changed.html` | Security notifications → Password changed | `Your Qorpera password was changed` |

Codes are 8 digits (Auth → Email OTP length 8, `supabase/config.toml` `otp_length`); each template draws one tile per digit with `slice .Token` (grouped 4+4). The images load from `https://app.qorpera.com/assets/brand/` (`public/assets/brand/`): the lockup and `crown-glance.gif`, the crown looking down at the code and blinking. The web build must be live before these templates are saved.
