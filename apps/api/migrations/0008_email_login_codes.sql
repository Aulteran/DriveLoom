-- Email codes as a second sign-in step (instance option, needs SMTP).
ALTER TABLE one_time_codes DROP CONSTRAINT one_time_codes_purpose_check;
ALTER TABLE one_time_codes ADD CONSTRAINT one_time_codes_purpose_check CHECK (purpose IN ('verify_email', 'recover_account', 'sign_in'));
