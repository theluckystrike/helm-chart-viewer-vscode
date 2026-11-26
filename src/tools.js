'use strict';
// Pro tools for Helm Chart & Values Viewer:
//   1. auditChart: Offline Markdown Helm chart security & drift audit across one file or a folder.
//   2. diffValues: Two-file values.yaml comparator in Markdown.
//   3. exportValuesDoc: Non-destructive Markdown + CSV parameter reference table export.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const {
  parseHelmFile,
  buildAuditMarkdown,
  buildDiffMarkdown,
  buildValuesDocMarkdown,
  buildValuesDocCsv,
} = require('./helm');

const HELM_FILE_RE = /^(Chart\.(yaml|yml|lock)|values([.-].*)?\.ya?ml)$/i;
const HELM_FILTERS = { 'Helm Chart & Values Files': ['yaml', 'yml', 'lock'] };

function uniquePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  for (let i = 1; i < 10000; i += 1) {
    const cand = path.join(dir, `${base}-${i}${ext}`);
    if (!fs.existsSync(cand)) return cand;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

async function resolveTargetUri(uri, provider, openLabel = 'Select Helm chart or values file') {
  if (uri && uri.scheme) return uri;
  if (provider && provider.active && provider.active.uri) return provider.active.uri;
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document && HELM_FILE_RE.test(path.basename(ed.document.uri.fsPath || ed.document.uri.path))) {
    return ed.document.uri;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: HELM_FILTERS,
    openLabel,
  });
  return picked && picked[0] ? picked[0] : null;
}

function listHelmFilesInDir(dirPath, maxDepth = 4) {
  const out = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isFile() && HELM_FILE_RE.test(e.name)) out.push(full);
      else if (e.isDirectory() && depth < maxDepth) walk(full, depth + 1);
    }
  }
  walk(dirPath, 0);
  return out.sort();
}

function createTools({ provider, pro, reach }) {
  async function auditChart(uri, opts = {}) {
    if (!(await pro.allowed('auditChart', opts))) return undefined;
    const target = await resolveTargetUri(uri, provider);
    if (!target) return undefined;

    const targetPath = target.fsPath;
    const isDir = target.scheme === 'file' && fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
    const files = isDir ? listHelmFilesInDir(targetPath) : [targetPath];
    if (!files.length) {
      vscode.window.showInformationMessage('No Helm chart or values files were found in this folder.');
      return undefined;
    }

    const entries = [];
    for (const f of files) {
      const buf = f === targetPath && target.scheme !== 'file'
        ? Buffer.from(await vscode.workspace.fs.readFile(target))
        : fs.readFileSync(f);
      entries.push({ fileName: path.basename(f), parsed: parseHelmFile(buf, path.basename(f)) });
    }
    const md = buildAuditMarkdown(entries);
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
    await pro.produced('auditChart');
    if (reach) reach.refresh();
    return { files: files.length, markdown: md };
  }

  async function diffValues(uri, opts = {}) {
    if (!(await pro.allowed('diffValues', opts))) return undefined;
    const left = await resolveTargetUri(uri, provider, 'Select baseline values.yaml file');
    if (!left) return undefined;

    let right = opts.compareUri || null;
    if (!right) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: HELM_FILTERS,
        openLabel: 'Select second values.yaml file to compare',
      });
      right = picked && picked[0] ? picked[0] : null;
    }
    if (!right) return undefined;

    const leftBuf = Buffer.from(await vscode.workspace.fs.readFile(left));
    const rightBuf = Buffer.from(await vscode.workspace.fs.readFile(right));
    const leftName = path.basename(left.fsPath || left.path);
    const rightName = path.basename(right.fsPath || right.path);
    const md = buildDiffMarkdown(
      leftName,
      parseHelmFile(leftBuf, leftName),
      rightName,
      parseHelmFile(rightBuf, rightName),
    );
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
    await pro.produced('diffValues');
    if (reach) reach.refresh();
    return { markdown: md };
  }

  async function exportValuesDoc(uri, opts = {}) {
    if (!(await pro.allowed('exportValuesDoc', opts))) return undefined;
    const target = await resolveTargetUri(uri, provider);
    if (!target) return undefined;

    const targetPath = target.fsPath;
    const bytes = await vscode.workspace.fs.readFile(target);
    const baseName = path.basename(targetPath);
    const parsed = parseHelmFile(Buffer.from(bytes), baseName);
    const stemRaw = baseName.replace(/\.(ya?ml|lock)$/i, '') || 'values';
    const defaultOut = uniquePath(path.join(path.dirname(targetPath), `${stemRaw}.reference.md`));
    const saveUri = opts.outPath
      ? vscode.Uri.file(uniquePath(opts.outPath))
      : await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultOut),
        filters: { 'Markdown Parameter Reference': ['md'] },
        saveLabel: 'Save Helm parameter reference',
      });
    if (!saveUri) return undefined;

    const mdPath = uniquePath(saveUri.fsPath);
    const dir = path.dirname(mdPath);
    const stem = path.basename(mdPath, '.md').replace(/\.reference$/i, '');
    const csvPath = uniquePath(path.join(dir, `${stem}.reference.csv`));

    fs.writeFileSync(mdPath, buildValuesDocMarkdown(parsed, baseName), 'utf8');
    fs.writeFileSync(csvPath, buildValuesDocCsv(parsed), 'utf8');

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mdPath));
    await vscode.window.showTextDocument(doc, { preview: false });
    await pro.produced('exportValuesDoc');
    if (reach) reach.refresh();
    return { files: [mdPath, csvPath], keys: parsed.stats.keyCount };
  }

  return { auditChart, diffValues, exportValuesDoc };
}

module.exports = { createTools, uniquePath, listHelmFilesInDir };
