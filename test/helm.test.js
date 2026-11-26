'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  parseHelmFile,
  buildAuditMarkdown,
  buildDiffMarkdown,
  buildValuesDocMarkdown,
  buildValuesDocCsv,
} = require('../src/helm');
const { HelmViewModel } = require('../src/view');
const { editorHtml, csp } = require('../src/html');

describe('Helm Chart & Values parser and static checks', () => {
  it('parses Chart.yaml metadata, dependencies and flags legacy apiVersion and unpinned deps', () => {
    const chartYaml = [
      'apiVersion: v1',
      'name: billing',
      'version: 1.0.0',
      'appVersion: "2.0.0"',
      'dependencies:',
      '  - name: redis',
      '    version: "*"',
      '    repository: http://charts.example.com',
    ].join('\n');
    const parsed = parseHelmFile(chartYaml, 'Chart.yaml');
    assert.equal(parsed.fileKind, 'Chart.yaml');
    assert.equal(parsed.metadata.name, 'billing');
    assert.equal(parsed.dependencies.length, 1);
    assert.ok(parsed.findings.some((f) => f.category === 'Deprecation'));
    assert.ok(parsed.findings.some((f) => f.category === 'Dependency'));
    assert.ok(parsed.findings.some((f) => f.category === 'URL'));
  });

  it('flattens values.yaml keys and flags hardcoded secrets, :latest tag and empty resources', () => {
    const valuesYaml = [
      'image:',
      '  repository: nginx',
      '  tag: latest',
      'resources: {}',
      'auth:',
      '  password: super-secret-password-123',
    ].join('\n');
    const parsed = parseHelmFile(valuesYaml, 'values.yaml');
    assert.equal(parsed.fileKind, 'values.yaml');
    assert.ok(parsed.stats.keyCount >= 4);
    assert.equal(parsed.stats.secretCount, 1);
    const pw = parsed.keys.find((k) => k.path === 'auth.password');
    assert.ok(pw.displayValue.includes('redacted'));
    assert.ok(parsed.findings.some((f) => f.category === 'Secret'));
    assert.ok(parsed.findings.some((f) => f.category === 'Image'));
    assert.ok(parsed.findings.some((f) => f.category === 'Reliability'));
  });

  it('parses the bundled sample values.yaml and Chart.yaml cleanly', () => {
    const vBuf = fs.readFileSync(path.join(__dirname, '..', 'samples', 'values.yaml'));
    const vParsed = parseHelmFile(vBuf, 'values.yaml');
    assert.ok(vParsed.stats.keyCount >= 10);
    assert.ok(vParsed.stats.errorCount >= 1);
    assert.ok(vParsed.stats.warningCount >= 2);

    const cBuf = fs.readFileSync(path.join(__dirname, '..', 'samples', 'Chart.yaml'));
    const cParsed = parseHelmFile(cBuf, 'Chart.yaml');
    assert.equal(cParsed.dependencies.length, 2);
  });

  it('builds audit, diff and Markdown/CSV parameter reference outputs', () => {
    const a = parseHelmFile('replicaCount: 1\nimage:\n  tag: "1.0.0"\n', 'values.staging.yaml');
    const b = parseHelmFile('replicaCount: 3\nimage:\n  tag: "1.1.0"\nmetrics:\n  enabled: true\n', 'values.prod.yaml');
    const audit = buildAuditMarkdown([{ fileName: 'values.staging.yaml', parsed: a }]);
    assert.ok(audit.includes('# Helm Chart Security & Drift Audit'));
    const diff = buildDiffMarkdown('values.staging.yaml', a, 'values.prod.yaml', b);
    assert.ok(diff.includes('| `replicaCount` | Changed |'));
    assert.ok(diff.includes('| `metrics.enabled` | Added |'));
    const docMd = buildValuesDocMarkdown(b, 'values.prod.yaml');
    assert.ok(docMd.includes('# Helm Values Parameter Reference (values.prod.yaml)'));
    const docCsv = buildValuesDocCsv(b);
    assert.ok(docCsv.includes('index,key,type,defaultValue,line,status'));
  });
});

describe('HelmViewModel and HTML CSP', () => {
  it('filters keys and returns detail payload', () => {
    const parsed = parseHelmFile('replicaCount: 2\nimage:\n  tag: "1.2.3"\n', 'values.yaml');
    const vm = new HelmViewModel(parsed, 'values.yaml', 64);
    assert.equal(vm.totalCount(), 2);
    assert.equal(vm.setFilter({ text: 'image.tag' }), 1);
    assert.equal(vm.rows(0, 10).length, 1);
    assert.equal(vm.detail(2).path, 'image.tag');
  });

  it('renders strict CSP without unsafe-inline', () => {
    const policy = csp('vscode-webview://x', 'nonce123');
    assert.ok(policy.includes("default-src 'none'"));
    assert.ok(!policy.includes('unsafe-inline'));
    const html = editorHtml({ cspSource: 'vscode-webview://x', script: 'viewer.js', styleUri: 'viewer.css', title: 'values.yaml', nonce: 'nonce123' });
    assert.ok(html.includes('nonce="nonce123"'));
  });
});
