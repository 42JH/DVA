ALTER TABLE admin_users
    DROP CONSTRAINT admin_users_status_check,
    ADD CONSTRAINT admin_users_status_check
        CHECK (status IN ('ACTIVE', 'PENDING'));