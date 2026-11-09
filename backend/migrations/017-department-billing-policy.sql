ALTER TABLE customers ADD COLUMN monthly_billing_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE organizations ADD COLUMN monthly_billing_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE departments (
 department_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 organization_seq integer NOT NULL REFERENCES organizations(organization_seq),
 name text NOT NULL CHECK (name=btrim(name) AND length(name) BETWEEN 1 AND 100),
 group_billing_enabled boolean NOT NULL DEFAULT false,
 UNIQUE (organization_seq,name),
 UNIQUE (department_seq,organization_seq)
);
ALTER TABLE memberships ADD COLUMN department_seq integer;

-- An existing member must be assigned using the actual team list, never a default team.
-- Before upgrading a populated DB, load the documented staging table with real assignments.
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM memberships) THEN
  IF to_regclass('public.migration_department_assignments') IS NULL THEN
   RAISE EXCEPTION 'Real department assignments are required: load migration_department_assignments before upgrading';
  END IF;
  IF EXISTS(SELECT customer_seq FROM migration_department_assignments GROUP BY customer_seq HAVING count(*)<>1) THEN
   RAISE EXCEPTION 'Each customer must have exactly one actual department assignment';
  END IF;
  IF EXISTS(SELECT 1 FROM migration_department_assignments a
   LEFT JOIN memberships m ON m.customer_seq=a.customer_seq AND m.organization_seq=a.organization_seq
   WHERE m.membership_seq IS NULL) THEN
   RAISE EXCEPTION 'Department assignments must match existing organization memberships';
  END IF;
  INSERT INTO departments(organization_seq,name)
   SELECT DISTINCT organization_seq,department_name FROM migration_department_assignments;
  UPDATE memberships m SET department_seq=d.department_seq
   FROM migration_department_assignments a JOIN departments d
    ON d.organization_seq=a.organization_seq AND d.name=a.department_name
   WHERE m.customer_seq=a.customer_seq AND m.organization_seq=a.organization_seq;
  IF EXISTS(SELECT 1 FROM memberships WHERE department_seq IS NULL) THEN
   RAISE EXCEPTION 'Every existing member needs one actual department assignment';
  END IF;
 END IF;
END $$;
ALTER TABLE memberships ALTER COLUMN department_seq SET NOT NULL;
ALTER TABLE memberships ADD CONSTRAINT memberships_department_company_fk
 FOREIGN KEY (department_seq,organization_seq) REFERENCES departments(department_seq,organization_seq);
CREATE INDEX memberships_department_idx ON memberships(department_seq);
DROP TABLE IF EXISTS migration_department_assignments;
