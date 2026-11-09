-- 기업별 사번: 문자열로 저장해 선행 0과 영문을 보존한다.
ALTER TABLE memberships
    ADD COLUMN employee_no text NOT NULL,
    ADD CONSTRAINT memberships_employee_no_check
        CHECK (btrim(employee_no) <> ''),
    ADD CONSTRAINT memberships_organization_employee_no_key
        UNIQUE (organization_seq, employee_no);

-- 고객 상태: 활성 / 탈퇴
ALTER TABLE customers
    DROP CONSTRAINT customers_status_check,
    ADD CONSTRAINT customers_status_check
        CHECK (status IN ('ACTIVE', 'WITHDRAWN'));

-- 기업 상태: 활성 / 비활성
ALTER TABLE organizations
    DROP CONSTRAINT organizations_status_check,
    ADD CONSTRAINT organizations_status_check
        CHECK (status IN ('ACTIVE', 'INACTIVE'));