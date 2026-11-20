function availableCallSql(prefix: '' | 'c.') {
  return `${prefix}deleted_at IS NULL AND (${prefix}incoming_at IS NULL OR ${prefix}incoming_at>clock_timestamp()-interval '5 years')`;
}

export const AVAILABLE_CALL_SQL = availableCallSql('');
export const AVAILABLE_JOINED_CALL_SQL = availableCallSql('c.');
