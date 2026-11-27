import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const helper = new URL('../src/lib/careers-form.ts', import.meta.url);
const readSource = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the CV field accepts only nonempty PDF, DOC or DOCX files up to 5 MiB', async () => {
  assert.ok(existsSync(helper), 'Careers needs client-side CV validation');
  const { careerCvError } = await import(helper);
  assert.equal(careerCvError(new File(['pdf'], 'Amina Hassan.PDF')), '');
  assert.equal(careerCvError(new File(['doc'], 'CV.doc')), '');
  assert.equal(careerCvError(new File(['docx'], 'CV.docx')), '');
  assert.match(careerCvError(null), /choose.*cv/i);
  assert.match(careerCvError(new File([], 'CV.docx')), /empty/i);
  assert.match(careerCvError(new File(['zip'], 'CV.zip')), /PDF, DOC or DOCX/i);
  assert.match(careerCvError(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'CV.pdf')), /5 MB/i);
});

test('failed or unreachable saves return a retry message without changing the application data', async () => {
  assert.ok(existsSync(helper), 'Careers needs a confirmed-save submission handler');
  const { saveCareerForm } = await import(helper);
  const data = new FormData();
  data.set('careerId', 'general');
  data.set('fullName', 'Amina Hassan');
  data.set('cv', new File(['pdf'], 'Amina Hassan.pdf'));

  const rejected = await saveCareerForm(data, async () => ({
    success: false,
    message: 'Please retry shortly.',
  }));
  assert.equal(rejected.success, false);
  assert.match(rejected.message, /retry/i);

  const unavailable = await saveCareerForm(data, async () => {
    throw new Error('Service unavailable. Please try again.');
  });
  assert.equal(unavailable.success, false);
  assert.match(unavailable.message, /try again/i);

  const saved = await saveCareerForm(data, async (id, sent) => {
    assert.equal(id, 'general');
    assert.equal(sent.get('cv').name, 'Amina Hassan.pdf');
    return { success: true, message: 'Application received.' };
  });
  assert.equal(saved.success, true);
  assert.equal(data.get('fullName'), 'Amina Hassan');
});

test('both routes render the shared multipart form, and department filters are toggle buttons', () => {
  const careers = readSource('../src/pages/careers.astro');
  const role = readSource('../src/pages/careers/[slug].astro');
  assert.match(careers, /<CareerApplicationForm\s/);
  assert.match(role, /<CareerApplicationForm\s/);
  assert.match(careers, /aria-pressed=/);
  assert.doesNotMatch(careers, /role="tablist"/);

  const form = readSource('../src/components/careers/CareerApplicationForm.astro');
  assert.match(form, /enctype="multipart\/form-data"/);
  assert.match(form, /type="file"[\s\S]*?name="cv"[\s\S]*?required/);
});

test('phone validation accepts Kenyan local and international numbers with common formatting', async () => {
  const { careerPhoneNumber } = await import(helper);
  assert.equal(careerPhoneNumber('0712 345 678'), '0712345678');
  assert.equal(careerPhoneNumber('+254 (712) 345-678'), '+254712345678');
  assert.equal(careerPhoneNumber('254 112 345 678'), '254112345678');
  assert.equal(careerPhoneNumber('+44 20 7946 0958'), '+442079460958');
  assert.equal(careerPhoneNumber('071234'), '');
});

test('optional professional links require an explicit HTTPS URL', async () => {
  const { isCareerLink } = await import(helper);
  assert.ok(isCareerLink(''));
  assert.ok(isCareerLink('https://example.com/profile'));
  assert.equal(isCareerLink('http://example.com/profile'), false);
  assert.equal(isCareerLink('https:example.com'), false);
  assert.equal(isCareerLink('https://user:pass@example.com'), false);
  assert.equal(isCareerLink('https://example.com/two words'), false);
  assert.equal(isCareerLink('https://example.com/a/../b'), false);
  assert.equal(isCareerLink('https://example.com/a/%2e%2e%2fb'), false);
  assert.equal(isCareerLink('https://example.com/a/%252e%252e%252fb'), false);
});

test('the dashboard application panel uses a native dialog and safe runtime rendering', () => {
  const panel = readSource('../src/components/dashboard/CareerApplications.astro');
  assert.match(panel, /<dialog/);
  assert.match(panel, /\.showModal\(\)/);
  assert.match(panel, /fetchCareerApplicationPage/);
  assert.match(panel, /downloadCareerCv/);
  assert.match(panel, /textContent\s*=/);
  assert.doesNotMatch(
    panel,
    /innerHTML|insertAdjacentHTML|set:html|localStorage|sessionStorage|<iframe|<embed/
  );
});
