// Splits a migration for D1 batch execution. CREATE TRIGGER bodies contain
// semicolons, so a trigger ends only at the END that matches its BEGIN.
export function migrationStatements(sql) {
  const statements = []
  let current = ''
  for (const part of sql.replace(/--[^\n]*/g, '').split(';')) {
    current = current ? `${current};${part}` : part
    const text = current.trim()
    if (/^CREATE\s+TRIGGER\b/i.test(text)) {
      const words = text.toUpperCase().match(/\b(?:BEGIN|CASE|END)\b/g) ?? []
      if (!words.includes('BEGIN') || words.reduce((depth, word) => depth + (word === 'END' ? -1 : 1), 0) > 0) continue
    }
    if (text) statements.push(text)
    current = ''
  }
  if (current.trim()) statements.push(current.trim())
  return statements
}
