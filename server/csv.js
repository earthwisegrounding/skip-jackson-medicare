'use strict';
// CSV writer with spreadsheet formula-injection protection.

const DANGEROUS = /^[=+\-@\t\r]/;

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : String(value);
  if (DANGEROUS.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(columns, rows) {
  const lines = [columns.map((c) => csvCell(c.label || c.key)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.get ? c.get(row) : row[c.key])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

module.exports = { csvCell, toCsv };
