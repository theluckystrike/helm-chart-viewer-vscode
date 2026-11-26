'use strict';
// View model for Helm Chart & Values Viewer: pagination, search/filter, dependencies and static findings.

class HelmViewModel {
  constructor(parsed, name, fileSize) {
    this.parsed = parsed;
    this.name = name;
    this.fileSize = fileSize;
    this.filter = { text: '', status: '' };
    this.filtered = parsed.keys.slice();
  }

  summary() {
    const s = this.parsed.stats;
    return {
      name: this.name,
      fileSize: this.fileSize,
      fileKind: this.parsed.fileKind,
      metadata: this.parsed.metadata,
      keyCount: s.keyCount,
      dependencyCount: s.dependencyCount,
      secretCount: s.secretCount,
      errorCount: s.errorCount,
      warningCount: s.warningCount,
      dependencies: this.parsed.dependencies.slice(0, 200),
      findings: this.parsed.findings.slice(0, 400),
    };
  }

  totalCount() {
    return this.parsed.keys.length;
  }

  count() {
    return this.filtered.length;
  }

  setFilter(f) {
    const text = f && typeof f.text === 'string' ? f.text.trim().toLowerCase() : '';
    const status = f && typeof f.status === 'string' ? f.status.trim() : '';
    this.filter = { text, status };
    this.filtered = this.parsed.keys.filter((k) => {
      if (status === 'error' && k.status !== 'error') return false;
      if (status === 'warning' && k.status !== 'warning') return false;
      if (status === 'ok' && k.status !== 'ok') return false;
      if (status === 'secrets' && !k.isSecret) return false;
      if (text) {
        const hay = `${k.path} ${k.displayValue} ${k.type}`.toLowerCase();
        if (!hay.includes(text)) return false;
      }
      return true;
    });
    return this.filtered.length;
  }

  rows(from, limit) {
    const start = Math.max(0, Number(from) || 0);
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.filtered.slice(start, start + n).map((k) => ({
      index: k.index,
      path: k.path,
      type: k.type,
      displayValue: k.displayValue,
      line: k.line,
      isSecret: k.isSecret,
      findingCount: k.findings.length,
      status: k.status,
    }));
  }

  detail(index) {
    const k = this.parsed.keys.find((x) => x.index === index) || this.parsed.keys[0] || null;
    if (!k) return null;
    return {
      index: k.index,
      path: k.path,
      leafKey: k.leafKey,
      depth: k.depth,
      line: k.line,
      type: k.type,
      displayValue: k.displayValue,
      isSecret: k.isSecret,
      status: k.status,
      findings: k.findings,
    };
  }
}

module.exports = { HelmViewModel };
