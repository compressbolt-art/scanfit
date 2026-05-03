const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');

const checks = [
  ['Food raw label evidence', html.includes('rawLabelLines') && html.includes('foodEvidenceList')],
  ['Feeding formula visible', html.includes('feedingFormulaText') && html.includes('gramsFormula')],
  ['Paid report library', html.includes('savedReportsList') && html.includes('redownloadReport')],
  ['Paywall download gate', html.includes('requirePaid') && html.includes('scanfit_paid')],
  ['Exercise conditions', html.includes('exerciseAge') && html.includes('exerciseJoint') && html.includes('exerciseWarnings')],
  ['Old body photo upload removed', !html.includes('step1Section') && !html.includes('handleFileUpload') && !html.includes('currentScan')],
  ['English language flow', html.includes('en-US') && server.includes('Write all human-readable fields in')],
  ['PayPal server create/capture', server.includes('/api/paypal/create-order') && server.includes('/api/paypal/capture-order')],
  ['Mobile viewport', html.includes('viewport') && html.includes('@media (max-width:640px)')],
  ['Huashu report canvas', html.includes('Huashu HTML-native output') && html.includes('Huashu motion prescription')]
];

let passed = 0;
for (const [name, ok] of checks) {
  if (ok) passed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}`);
}

const score = Math.round((passed / checks.length) * 100);
console.log(`ScanFit readiness score: ${score}/100`);
process.exit(passed === checks.length ? 0 : 1);
