'use strict';
// Pure-JS offline Helm Chart.yaml / values.yaml / Chart.lock parser, static checker and report builders.
// Zero network calls, zero external dependencies.

const SECRET_KEY_RE = /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|signing[_-]?key)/i;
const SECRET_VAL_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{16,})\b/;
const PLACEHOLDER_RE = /^(?:|changeme|placeholder|example|dummy|test|replace[_-]?me|\$\{[^}]+\}|\{\{[^}]+\}\}|<[^>]+>|redacted|xxx+|\*+|null|false|true)$/i;
const DEPRECATED_APIS = new Set([
  'v1',
  'extensions/v1beta1',
  'apps/v1beta1',
  'apps/v1beta2',
  'networking.k8s.io/v1beta1',
  'policy/v1beta1',
]);

function stripInlineComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && line[i - 1] !== '\\') inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function splitInline(text) {
  const out = [];
  let cur = '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && text[i - 1] !== '\\') inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === '[' || ch === '{') depth += 1;
      else if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
      else if (ch === ',' && depth === 0) {
        out.push(cur.trim());
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseScalar(raw) {
  const s = String(raw || '').trim();
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) {
    return s.slice(1, -1);
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitInline(inner).map((item) => parseScalar(item));
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    const obj = {};
    if (!inner) return obj;
    for (const part of splitInline(inner)) {
      const idx = part.indexOf(':');
      if (idx > 0) obj[String(parseScalar(part.slice(0, idx)))] = parseScalar(part.slice(idx + 1));
    }
    return obj;
  }
  return s;
}

function findKeySep(text) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && text[i - 1] !== '\\') inDouble = !inDouble;
    else if (ch === ':' && !inSingle && !inDouble) {
      if (i + 1 === text.length || /\s/.test(text[i + 1])) return i;
    }
  }
  return -1;
}

function parseYaml(text) {
  const rawLines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const tokens = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const clean = stripInlineComment(rawLines[i]).replace(/\t/g, '  ');
    const trimmed = clean.trim();
    if (!trimmed || trimmed === '---' || trimmed === '...') continue;
    const indent = clean.match(/^ */)[0].length;
    tokens.push({ indent, text: trimmed, line: i + 1 });
  }
  if (!tokens.length) return { data: {}, lineMap: new Map() };

  const lineMap = new Map();
  let pos = 0;

  function readBlockScalar(parentIndent) {
    const lines = [];
    while (pos < tokens.length && tokens[pos].indent > parentIndent) {
      lines.push(tokens[pos].text);
      pos += 1;
    }
    return lines.join('\n');
  }

  function parseBlock(minIndent, prefix) {
    if (pos >= tokens.length || tokens[pos].indent < minIndent) return null;
    if (tokens[pos].text === '-' || tokens[pos].text.startsWith('- ')) {
      return parseSeq(tokens[pos].indent, prefix);
    }
    return parseMap(tokens[pos].indent, prefix);
  }

  function parseSeq(seqIndent, prefix) {
    const arr = [];
    while (pos < tokens.length) {
      const tok = tokens[pos];
      if (tok.indent < seqIndent || tok.indent > seqIndent) break;
      if (!(tok.text === '-' || tok.text.startsWith('- '))) break;
      const idxPrefix = prefix ? `${prefix}[${arr.length}]` : `[${arr.length}]`;
      lineMap.set(idxPrefix, tok.line);
      const rest = tok.text === '-' ? '' : tok.text.slice(2).trim();
      pos += 1;
      if (!rest) {
        if (pos < tokens.length && tokens[pos].indent > seqIndent) {
          arr.push(parseBlock(tokens[pos].indent, idxPrefix));
        } else {
          arr.push(null);
        }
      } else {
        const sep = findKeySep(rest);
        if (sep > 0) {
          const itemObj = {};
          const k = String(parseScalar(rest.slice(0, sep)));
          const keyPath = `${idxPrefix}.${k}`;
          lineMap.set(keyPath, tok.line);
          const vRaw = rest.slice(sep + 1).trim();
          const itemIndent = seqIndent + 2;
          if (!vRaw) {
            itemObj[k] = (pos < tokens.length && tokens[pos].indent > itemIndent)
              ? parseBlock(tokens[pos].indent, keyPath)
              : null;
          } else if (vRaw === '|' || vRaw === '>' || vRaw === '|-' || vRaw === '>-') {
            itemObj[k] = readBlockScalar(itemIndent);
          } else {
            itemObj[k] = parseScalar(vRaw);
          }
          if (pos < tokens.length && tokens[pos].indent >= itemIndent && !(tokens[pos].indent === seqIndent && tokens[pos].text.startsWith('-'))) {
            const extra = parseMap(tokens[pos].indent, idxPrefix);
            if (extra && typeof extra === 'object' && !Array.isArray(extra)) Object.assign(itemObj, extra);
          }
          arr.push(itemObj);
        } else {
          arr.push(parseScalar(rest));
        }
      }
    }
    return arr;
  }

  function parseMap(mapIndent, prefix) {
    const obj = {};
    while (pos < tokens.length) {
      const tok = tokens[pos];
      if (tok.indent < mapIndent) break;
      if (tok.indent > mapIndent) {
        pos += 1;
        continue;
      }
      if (tok.text === '-' || tok.text.startsWith('- ')) break;
      const sep = findKeySep(tok.text);
      if (sep <= 0) {
        pos += 1;
        continue;
      }
      const k = String(parseScalar(tok.text.slice(0, sep)));
      const keyPath = prefix ? `${prefix}.${k}` : k;
      lineMap.set(keyPath, tok.line);
      const vRaw = tok.text.slice(sep + 1).trim();
      pos += 1;
      if (!vRaw) {
        if (pos < tokens.length && tokens[pos].indent > mapIndent) {
          obj[k] = parseBlock(tokens[pos].indent, keyPath);
        } else if (pos < tokens.length && tokens[pos].indent === mapIndent && (tokens[pos].text === '-' || tokens[pos].text.startsWith('- '))) {
          obj[k] = parseSeq(mapIndent, keyPath);
        } else {
          obj[k] = null;
        }
      } else if (vRaw === '|' || vRaw === '>' || vRaw === '|-' || vRaw === '>-') {
        obj[k] = readBlockScalar(mapIndent);
      } else {
        obj[k] = parseScalar(vRaw);
      }
    }
    return obj;
  }

  const data = parseBlock(tokens[0].indent, '');
  return { data: (data && typeof data === 'object' && !Array.isArray(data)) ? data : {}, lineMap };
}

function detectFileKind(fileName, data) {
  const lower = String(fileName || '').toLowerCase();
  if (lower === 'chart.lock') return 'Chart.lock';
  if (lower === 'chart.yaml' || lower === 'chart.yml') return 'Chart.yaml';
  if (data && typeof data.apiVersion === 'string' && typeof data.name === 'string' && typeof data.version === 'string' && !data.image) {
    return 'Chart.yaml';
  }
  return 'values.yaml';
}

function typeOfVal(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function displayVal(v, isSecret) {
  if (isSecret && typeof v === 'string' && v.length > 0 && !PLACEHOLDER_RE.test(v)) {
    return `${v.slice(0, 2)}*** (redacted)`;
  }
  if (v === null) return 'null';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function flattenValues(obj, lineMap) {
  const rows = [];
  function walk(node, prefix, depth) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [k, v] of Object.entries(node)) {
      const p = prefix ? `${prefix}.${k}` : k;
      const line = lineMap.get(p) || 1;
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) {
        walk(v, p, depth + 1);
      } else {
        rows.push({
          index: rows.length + 1,
          path: p,
          leafKey: k,
          depth,
          line,
          type: typeOfVal(v),
          rawValue: v,
          displayValue: displayVal(v, false),
          isSecret: false,
          findings: [],
          status: 'ok',
        });
      }
    }
  }
  walk(obj, '', 0);
  return rows;
}

function parseHelmFile(input, fileName = 'values.yaml') {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input || '');
  const { data, lineMap } = parseYaml(text);
  const fileKind = detectFileKind(fileName, data);
  const findings = [];
  const keys = flattenValues(data, lineMap);

  const addFinding = (severity, category, keyPath, line, message, rowObj) => {
    const f = { severity, category, keyPath, line: line || 1, finding: message };
    findings.push(f);
    if (rowObj) {
      rowObj.findings.push(f);
      if (severity === 'error') rowObj.status = 'error';
      else if (rowObj.status === 'ok') rowObj.status = 'warning';
    }
  };

  // Chart metadata & dependencies
  const metadata = fileKind === 'Chart.yaml' || fileKind === 'Chart.lock'
    ? {
      name: data.name || '',
      version: data.version || '',
      appVersion: data.appVersion || '',
      apiVersion: data.apiVersion || '',
      type: data.type || 'application',
      description: data.description || '',
      kubeVersion: data.kubeVersion || '',
      digest: data.digest || '',
      generated: data.generated || '',
    }
    : null;

  const rawDeps = Array.isArray(data.dependencies) ? data.dependencies : [];
  const dependencies = rawDeps.filter((d) => d && typeof d === 'object').map((d, i) => {
    const dep = {
      name: String(d.name || `dep-${i + 1}`),
      version: String(d.version || ''),
      repository: String(d.repository || ''),
      condition: String(d.condition || ''),
      alias: String(d.alias || ''),
      line: lineMap.get(`dependencies[${i}]`) || 1,
    };
    if (!dep.version || dep.version === '*' || dep.version.includes('x')) {
      addFinding('warning', 'Dependency', `dependencies[${i}].version`, dep.line, `Dependency "${dep.name}" uses unpinned version "${dep.version || '(empty)'}".`);
    }
    if (dep.repository.startsWith('http://')) {
      addFinding('warning', 'URL', `dependencies[${i}].repository`, dep.line, `Dependency "${dep.name}" uses unencrypted http:// repository (${dep.repository}).`);
    }
    return dep;
  });

  if (fileKind === 'Chart.yaml' && data.apiVersion && DEPRECATED_APIS.has(String(data.apiVersion))) {
    addFinding('warning', 'Deprecation', 'apiVersion', lineMap.get('apiVersion') || 1, `Chart.yaml uses legacy apiVersion "${data.apiVersion}" (prefer v2 for Helm 3).`);
  }

  // Static checks on flattened keys
  for (const row of keys) {
    const strVal = row.rawValue == null ? '' : String(row.rawValue);
    const lowerPath = row.path.toLowerCase();

    if (typeof row.rawValue === 'string' && strVal && !PLACEHOLDER_RE.test(strVal)) {
      if (SECRET_KEY_RE.test(row.leafKey) || SECRET_VAL_RE.test(strVal)) {
        row.isSecret = true;
        row.displayValue = displayVal(row.rawValue, true);
        addFinding('error', 'Secret', row.path, row.line, `Key "${row.path}" appears to contain a hardcoded secret.`, row);
      }
    }

    if ((/(?:^|\.)tag$/.test(lowerPath) && strVal === 'latest') || (/(?:^|\.)image$/.test(lowerPath) && strVal.endsWith(':latest'))) {
      addFinding('warning', 'Image', row.path, row.line, `Mutable :latest image tag configured at "${row.path}".`, row);
    }

    if (/(?:^|\.)apiversion$/i.test(lowerPath) && fileKind !== 'Chart.yaml' && DEPRECATED_APIS.has(strVal)) {
      addFinding('warning', 'Deprecation', row.path, row.line, `Deprecated Kubernetes apiVersion "${strVal}" at "${row.path}".`, row);
    }

    if (/(?:^|\.)resources$/.test(lowerPath) && row.rawValue && typeof row.rawValue === 'object' && Object.keys(row.rawValue).length === 0) {
      addFinding('warning', 'Reliability', row.path, row.line, `Empty resources block ({}) at "${row.path}": no CPU/memory limits set.`, row);
    }

    if (typeof row.rawValue === 'string' && /^http:\/\//i.test(strVal)) {
      addFinding('warning', 'URL', row.path, row.line, `Unencrypted http:// URL configured at "${row.path}".`, row);
    }
  }

  // Check nested resources objects that have requests but no limits
  function checkResourcesObj(node, prefix) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [k, v] of Object.entries(node)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (k === 'resources' && v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) {
        const lim = v.limits;
        if (!lim || typeof lim !== 'object' || (!lim.cpu && !lim.memory)) {
          addFinding('warning', 'Reliability', p, lineMap.get(p) || 1, `Resource block "${p}" is missing limits (cpu/memory).`);
        }
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        checkResourcesObj(v, p);
      }
    }
  }
  checkResourcesObj(data, '');

  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;
  const secretCount = findings.filter((f) => f.category === 'Secret').length;

  return {
    fileName,
    fileKind,
    metadata,
    dependencies,
    keys,
    findings,
    stats: {
      keyCount: keys.length,
      dependencyCount: dependencies.length,
      secretCount,
      errorCount,
      warningCount,
    },
  };
}

function buildAuditMarkdown(entries) {
  const lines = [
    '# Helm Chart Security & Drift Audit',
    '',
    `Generated offline on ${new Date().toISOString().slice(0, 10)}.`,
    '',
    '## File Summary',
    '',
    '| File | Kind | Keys | Dependencies | Errors | Warnings |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
  ];
  for (const e of entries) {
    const s = e.parsed.stats;
    lines.push(`| ${e.fileName} | ${e.parsed.fileKind} | ${s.keyCount} | ${s.dependencyCount} | ${s.errorCount} | ${s.warningCount} |`);
  }
  lines.push('', '## Findings', '');
  const allFindings = entries.flatMap((e) => e.parsed.findings.map((f) => ({ file: e.fileName, ...f })));
  if (!allFindings.length) {
    lines.push('All scanned Helm files passed security and configuration checks.');
  } else {
    lines.push('| File | Severity | Category | Key Path | Line | Finding |');
    lines.push('| --- | --- | --- | --- | ---: | --- |');
    for (const f of allFindings) {
      lines.push(`| ${f.file} | ${f.severity.toUpperCase()} | ${f.category} | \`${f.keyPath}\` | ${f.line} | ${f.finding.replace(/\|/g, '\\|')} |`);
    }
  }
  return lines.join('\n') + '\n';
}

function buildDiffMarkdown(leftName, leftParsed, rightName, rightParsed) {
  const leftMap = new Map(leftParsed.keys.map((k) => [k.path, k]));
  const rightMap = new Map(rightParsed.keys.map((k) => [k.path, k]));
  const allPaths = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort();

  const lines = [
    '# Helm Values Comparison',
    '',
    `- Baseline: \`${leftName}\` (${leftParsed.stats.keyCount} keys, ${leftParsed.stats.errorCount} errors, ${leftParsed.stats.warningCount} warnings)`,
    `- Target: \`${rightName}\` (${rightParsed.stats.keyCount} keys, ${rightParsed.stats.errorCount} errors, ${rightParsed.stats.warningCount} warnings)`,
    '',
    '| Key Path | Change | Baseline Value | Target Value |',
    '| --- | --- | --- | --- |',
  ];

  for (const p of allPaths) {
    const a = leftMap.get(p);
    const b = rightMap.get(p);
    if (!a && b) {
      lines.push(`| \`${p}\` | Added | - | \`${b.displayValue.replace(/\|/g, '\\|')}\` |`);
    } else if (a && !b) {
      lines.push(`| \`${p}\` | Removed | \`${a.displayValue.replace(/\|/g, '\\|')}\` | - |`);
    } else if (a.displayValue !== b.displayValue || a.type !== b.type) {
      lines.push(`| \`${p}\` | Changed | \`${a.displayValue.replace(/\|/g, '\\|')}\` | \`${b.displayValue.replace(/\|/g, '\\|')}\` |`);
    }
  }
  return lines.join('\n') + '\n';
}

function buildValuesDocMarkdown(parsed, fileName) {
  const lines = [
    `# Helm Values Parameter Reference (${fileName})`,
    '',
    '| Key | Type | Default | Status |',
    '| --- | --- | --- | --- |',
  ];
  for (const k of parsed.keys) {
    lines.push(`| \`${k.path}\` | ${k.type} | \`${k.displayValue.replace(/\|/g, '\\|')}\` | ${k.status.toUpperCase()} |`);
  }
  return lines.join('\n') + '\n';
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildValuesDocCsv(parsed) {
  const header = ['index', 'key', 'type', 'defaultValue', 'line', 'status'];
  const rows = parsed.keys.map((k) => [
    k.index,
    k.path,
    k.type,
    k.displayValue,
    k.line,
    k.status,
  ].map(csvCell).join(','));
  return [header.join(','), ...rows].join('\n') + '\n';
}

module.exports = {
  parseYaml,
  parseHelmFile,
  buildAuditMarkdown,
  buildDiffMarkdown,
  buildValuesDocMarkdown,
  buildValuesDocCsv,
};
