import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/ga4-consent.ts', import.meta.url), 'utf8')
  .replace(
    "import { getConsent } from './consent-manager';",
    'const getConsent = () => ({ categories: { analytics: true } });'
  )
  .replace('import.meta.env.PUBLIC_GA_MEASUREMENT_ID', "'G-BILLINGTEST'");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function visit(pathname) {
  const scripts = [];
  const context = {
    exports: {},
    window: { location: { pathname }, addEventListener() {} },
    document: {
      createElement: () => ({}),
      head: { appendChild: (script) => scripts.push(script.src) },
    },
  };
  vm.runInNewContext(compiled, context);
  return { scripts, events: context.window.dataLayer || [] };
}

test('billing and return never initialize analytics even after explicit analytics consent', () => {
  for (const pathname of ['/billing', '/billing/', '/billing/return', '/billing/return/']) {
    const result = visit(pathname);
    assert.deepEqual(result.scripts, [], pathname);
    assert.equal(result.events.length, 0, pathname);
  }
});

test('the billing privacy boundary preserves consented analytics on public marketing pages', () => {
  assert.equal(visit('/pricing').scripts.length, 1);
});
