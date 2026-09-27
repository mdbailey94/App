// Runs apps-script/Code.gs in Node against a small in-memory imitation of
// the Google Sheets services it uses, for tests and local end-to-end runs.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CODE = readFileSync(new URL('../../apps-script/Code.gs', import.meta.url), 'utf8');

class Sheet {
  constructor(name) { this.name = name; this.rows = []; this.raw = []; this.maxRows = 1000; this.formulas = {}; this.hidden = []; }
  getLastRow() { return this.rows.length; }
  getMaxRows() { return this.maxRows; }
  setFrozenRows() {} setFrozenColumns() {} setConditionalFormatRules(r) { this.rules = r; }
  hideColumns(c) { this.hidden.push(c); }
  getRange(row, col, nRows = 1, nCols = 1) {
    if (typeof row === 'string') {
      const sheet = this;
      return { setFormula(f) { sheet.formulas[row] = f; return this; } };
    }
    if (row < 1 || col < 1) throw new Error(`Invalid range ${row},${col}`);
    const sheet = this;
    const range = {
      getValues() {
        return Array.from({ length: nRows }, (_, r) => Array.from({ length: nCols }, (_, c) => sheet.rows[row - 1 + r]?.[col - 1 + c] ?? ''));
      },
      setValues(values) {
        if (values.length !== nRows || values.some((v) => v.length !== nCols)) throw new Error('Range size mismatch');
        values.forEach((vals, r) => {
          const target = (sheet.rows[row - 1 + r] ||= []);
          const raw = (sheet.raw[row - 1 + r] ||= []);
          vals.forEach((v, c) => { raw[col - 1 + c] = v; });
          // Like Sheets: a leading apostrophe forces plain text and is not shown.
          vals.forEach((v, c) => { target[col - 1 + c] = typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v; });
        });
        return range;
      },
      setFontWeight() { return range; },
    };
    return range;
  }
}

function makeServices() {
  const sheets = new Map();
  const ss = {
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { const s = new Sheet(n); sheets.set(n, s); return s; },
  };
  const rule = () => {
    const b = new Proxy({}, { get: (_, k) => (k === 'build' ? () => ({}) : () => b) });
    return b;
  };
  return {
    sheets,
    globals: {
      SpreadsheetApp: { getActiveSpreadsheet: () => ss, newConditionalFormatRule: rule },
      ContentService: {
        MimeType: { JSON: 'json' },
        createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
      },
      LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    },
  };
}

export function loadAppsScript({ groupCode = 'EAGLES', coachPassword = 'secret' } = {}) {
  const { sheets, globals } = makeServices();
  const source = CODE
    .replace("const GROUP_CODE = 'CHANGE-ME';", `const GROUP_CODE = ${JSON.stringify(groupCode)};`)
    .replace("const COACH_PASSWORD = 'change-me-too';", `const COACH_PASSWORD = ${JSON.stringify(coachPassword)};`);
  const ctx = vm.createContext({ ...globals, JSON, Date, Map, Math, Number, String, Array, Object, isFinite });
  vm.runInContext(source, ctx);
  return {
    sheets,
    post(body) {
      const out = ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
      return JSON.parse(out.text);
    },
  };
}
