/**
 * CSV encoding utility following RFC 4180
 * Handles formula injection protection and UTF-8 BOM
 */

/**
 * Escapes a field value for safe CSV export
 * - Protects against formula injection by prefixing dangerous characters with '
 * - Wraps field in quotes if it contains ",", """, newline, or carriage return
 * - Escapes embedded quotes by doubling them
 */
function escapeCSVField(value: string): string {
  // Protect against formula injection
  // If field starts with =, +, -, @, tab, or carriage return, prefix with '
  if (value.match(/^[=+\-@\t\r]/)) {
    value = "'" + value
  }

  // Check if field needs to be quoted
  if (
    value.includes(',') ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    // Escape quotes by doubling them
    value = value.replace(/"/g, '""')
    // Wrap in quotes
    return `"${value}"`
  }

  return value
}

/**
 * Converts an array of records to CSV format with UTF-8 BOM
 * @param headers - Column headers
 * @param records - Array of record objects
 * @returns CSV string with UTF-8 BOM and CRLF line endings
 */
export function toCSV(
  headers: string[],
  records: Array<Record<string, string>>
): string {
  const lines: string[] = []

  // Add escaped headers
  lines.push(headers.map(escapeCSVField).join(','))

  // Add escaped data rows
  for (const record of records) {
    const row = headers.map(header => escapeCSVField(record[header] ?? ''))
    lines.push(row.join(','))
  }

  // Join with CRLF (RFC 4180 compliant)
  const csv = lines.join('\r\n') + '\r\n'

  // Add UTF-8 BOM to ensure Excel recognizes encoding properly
  const bom = '﻿'
  return bom + csv
}
