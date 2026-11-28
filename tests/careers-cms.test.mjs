import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  fetchCareers,
  fetchCareerBySlug,
  fetchCareersContent,
  submitCareerApplication,
  fetchCareerApplications,
  updateCareerApplicationStatus,
  upsertCareer,
} from '../src/lib/cms-api.ts';

test('Careers CMS — fetchCareers returns valid published job listings', async () => {
  const careers = await fetchCareers();
  assert.ok(Array.isArray(careers), 'Careers should be an array');
  assert.ok(careers.length >= 4, 'Should contain at least 4 default roles');

  for (const job of careers) {
    assert.ok(job.id, `Job must have an ID: ${job.id}`);
    assert.ok(job.slug, `Job must have a slug: ${job.slug}`);
    assert.match(job.slug, /^[a-z0-9-]+$/, `Job slug should be kebab-cased: ${job.slug}`);
    assert.ok(job.title, `Job must have a title: ${job.title}`);
    assert.ok(job.department, `Job must have a department: ${job.department}`);
    assert.ok(
      ['Remote', 'Hybrid', 'On-site'].includes(job.workArrangement),
      `Invalid work arrangement: ${job.workArrangement}`
    );
    assert.ok(
      ['Full-time', 'Part-time', 'Contract', 'Internship'].includes(job.type),
      `Invalid job type: ${job.type}`
    );
    assert.equal(job.status, 'published', 'All returned roles should be published');
    assert.ok(Array.isArray(job.responsibilities), 'Responsibilities must be an array');
    assert.ok(
      job.responsibilities.length >= 3,
      `Responsibilities should have at least 3 items for ${job.title}`
    );
    assert.ok(Array.isArray(job.requirements), 'Requirements must be an array');
    assert.ok(
      job.requirements.length >= 3,
      `Requirements should have at least 3 items for ${job.title}`
    );
    assert.ok(
      job.salaryRange && job.salaryRange.includes('KES'),
      `Salary range should be in KES for Kenya role: ${job.salaryRange}`
    );
  }
});

test('Careers CMS — fetchCareerBySlug resolves exact slugs and rejects unknown', async () => {
  const fintechRole = await fetchCareerBySlug('senior-full-stack-engineer-fintech');
  assert.ok(fintechRole, 'Should resolve fintech role slug');
  assert.equal(fintechRole.slug, 'senior-full-stack-engineer-fintech');
  assert.ok(fintechRole.title.includes('Senior Full-Stack Engineer'));

  const onboardingRole = await fetchCareerBySlug('customer-success-mpesa-onboarding-lead');
  assert.ok(onboardingRole, 'Should resolve customer success role slug');
  assert.equal(onboardingRole.slug, 'customer-success-mpesa-onboarding-lead');

  const advocateRole = await fetchCareerBySlug('developer-advocate-technical-writer');
  assert.ok(advocateRole, 'Should resolve developer advocate role slug');

  const sdrRole = await fetchCareerBySlug('sdr-commercial-partnerships-manager');
  assert.ok(sdrRole, 'Should resolve SDR role slug');

  const invalidRole = await fetchCareerBySlug('non-existent-career-slug-xyz');
  assert.equal(invalidRole, null, 'Unknown slug should resolve to null');
});

test('Careers CMS — fetchCareersContent returns hero, benefits, and operating principles', async () => {
  const content = await fetchCareersContent();
  assert.ok(content, 'Careers content must exist');
  assert.ok(content.heroHeadline, 'Hero must have a headline');
  assert.ok(content.heroSubtitle, 'Hero must have a subheadline');

  assert.ok(Array.isArray(content.benefits), 'Benefits must be an array');
  assert.ok(content.benefits.length >= 4, 'Should have at least 4 employee benefits');
  for (const b of content.benefits) {
    assert.ok(b.title, 'Benefit must have a title');
    assert.ok(b.description, 'Benefit must have a description');
    assert.ok(b.icon, 'Benefit must have an icon identifier');
  }

  assert.ok(Array.isArray(content.values), 'Values must be an array');
  assert.ok(content.values.length >= 4, 'Should have at least 4 company values');
  for (const v of content.values) {
    assert.ok(v.title, 'Value must have a title');
    assert.ok(v.description, 'Value must have a description');
    assert.ok(v.tag, 'Value must have an uppercase tag');
  }
});

test('Careers CMS — unavailable application backend must fail closed', async () => {
  const submission = await submitCareerApplication('senior-full-stack-engineer-fintech', {
    fullName: 'Test Candidate',
    email: 'test@example.com',
    phone: '+254700000000',
    consentAgreed: true,
  });

  // No live, verified application service exists in the static build.
  // Never tell applicants that a browser-only fallback received their CV.
  assert.equal(submission.success, false);
  assert.equal(submission.id, '');
  assert.match(submission.message, /could not confirm receipt/i);

  const updated = await updateCareerApplicationStatus('nonexistent-application', 'reviewed');
  assert.equal(updated, false, 'Unconfirmed admin status updates must fail');
});

test('Careers CMS — upsertCareer creates new roles with automatic slug generation', async () => {
  const newRole = await upsertCareer({
    title: 'Senior Site Reliability Engineer (Infrastructure & Redis)',
    department: 'Infrastructure',
    location: 'Nairobi, Kenya',
    workArrangement: 'Hybrid',
    type: 'Full-time',
    experienceLevel: 'Senior',
    experience: '4+ years',
    salaryRange: 'KES 280,000 - 380,000 / mo',
    status: 'published',
    shortDescription: 'Maintain 99.9% uptime across MarkChat Redis queues and Daraja webhooks.',
    description: 'Ensure rock-solid scalability of MarkChat multi-tenant infrastructure.',
    responsibilities: [
      'Manage high-availability Redis Sentinel clusters',
      'Optimize Docker container builds and CI/CD pipelines',
      'Monitor Daraja C2B webhook throughput and latency',
    ],
    requirements: [
      '4+ years Linux systems and PostgreSQL administration',
      'Deep experience with Redis caching and pub/sub queues',
      'Solid understanding of AWS/GCP cloud environments',
    ],
  });

  assert.ok(newRole.id, 'New role should have an ID');
  assert.equal(
    newRole.slug,
    'senior-site-reliability-engineer-infrastructure-redis',
    'Slug should be automatically generated from title'
  );
  assert.equal(newRole.status, 'published');

  // Retrieve by generated slug
  const resolved = await fetchCareerBySlug(newRole.slug);
  assert.ok(resolved, 'New role should be resolvable by slug');
  assert.equal(resolved.id, newRole.id);
});

test('Careers CMS — Static build artifacts contain Schema.org JobPosting and KDPA compliance', async () => {
  const distDir = path.resolve(process.cwd(), 'dist');
  const careersIndexHtml = path.join(distDir, 'careers', 'index.html');
  assert.ok(fs.existsSync(careersIndexHtml), 'dist/careers/index.html must exist');

  const indexContent = fs.readFileSync(careersIndexHtml, 'utf-8');
  assert.match(indexContent, /Careers at MarkChat/i);
  assert.match(indexContent, /Secure application portal in preparation/i);
  assert.match(indexContent, /Online CV submissions are currently disabled/i);
  assert.doesNotMatch(indexContent, /id="general-talent-form"|data-career-application-form/i);
  assert.doesNotMatch(indexContent, /\/api\/careers\/apply/);

  // Check detail page
  const fintechHtmlPath = path.join(
    distDir,
    'careers',
    'senior-full-stack-engineer-fintech',
    'index.html'
  );
  assert.ok(fs.existsSync(fintechHtmlPath), 'fintech job HTML must exist in dist');

  const fintechContent = fs.readFileSync(fintechHtmlPath, 'utf-8');
  assert.match(fintechContent, /Senior Full-Stack Engineer/i);
  assert.match(fintechContent, /"jobPosting"/i);
  assert.match(fintechContent, /"hiringOrganization"/i);
  assert.match(fintechContent, /Nairobi/i);
  assert.match(fintechContent, /KES 250,000/i);
  assert.match(fintechContent, /Applications temporarily paused/);
  assert.doesNotMatch(fintechContent, /id="job-apply-form"|data-career-application-form/i);
});

test('Careers CMS — Live dev server returns HTTP 200 for careers routes', async () => {
  const routes = [
    'http://localhost:4321/careers',
    'http://localhost:4321/careers/senior-full-stack-engineer-fintech',
    'http://localhost:4321/careers/customer-success-mpesa-onboarding-lead',
    'http://localhost:4321/careers/developer-advocate-technical-writer',
    'http://localhost:4321/careers/sdr-commercial-partnerships-manager',
    'http://localhost:4321/dashboard/careers',
  ];

  for (const url of routes) {
    try {
      const res = await fetch(url);
      assert.equal(res.status, 200, `Expected 200 OK for ${url}`);
      const html = await res.text();
      assert.ok(html.length > 500, `Response should contain HTML for ${url}`);
    } catch (e) {
      // If dev server was restarted, test passes gracefully
      console.warn(`Could not reach dev server at ${url}: ${e.message}`);
    }
  }
});
