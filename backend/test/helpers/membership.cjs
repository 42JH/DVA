// Explicit test data: production migrations never invent a default department.
async function testMembership(
  pool,
  {
    customerSeq,
    organizationSeq,
    employeeNo,
    role = 'MEMBER',
    status = 'ACTIVE',
    groupBillingEnabled = false,
  },
) {
  const department = (
    await pool.query(
      `INSERT INTO departments(organization_seq,name,group_billing_enabled) VALUES($1,'검증 부서',$2)
    ON CONFLICT(organization_seq,name) WHERE deleted_at IS NULL DO UPDATE SET group_billing_enabled=departments.group_billing_enabled OR EXCLUDED.group_billing_enabled RETURNING department_seq`,
      [organizationSeq, groupBillingEnabled],
    )
  ).rows[0].department_seq;
  return pool.query(
    `INSERT INTO memberships(customer_seq,organization_seq,employee_no,role,status,department_seq) VALUES($1,$2,$3,$4,$5,$6) RETURNING membership_seq`,
    [customerSeq, organizationSeq, employeeNo, role, status, department],
  );
}
module.exports = { testMembership };
