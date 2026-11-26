'use strict';
module.exports = {
  prefix: 'zovoHelm',
  triesKey: 'zovoHelm.proTrial',
  slot: '#protools',
  tools: [
    { id: 'auditChart', title: 'Audit Helm chart security and drift', command: 'zovoHelm.auditChart' },
    { id: 'diffValues', title: 'Compare two Helm values files', command: 'zovoHelm.diffValues' },
    { id: 'exportValuesDoc', title: 'Export values reference to Markdown and CSV', command: 'zovoHelm.exportValuesDoc' },
  ],
};
