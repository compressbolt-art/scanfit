const fs = require('fs/promises');
const path = require('path');

const root = path.resolve(__dirname, '..');
const imagesDir = path.join(root, 'public', 'images');
const outDir = path.join(root, 'data', 'breeds');
const outFile = path.join(outDir, '10group-results.json');
const model = process.env.OPENAI_MODEL || 'gpt-5.5';
const apiKey = process.env.OPENAI_API_KEY;

function normalizeFileName(name) {
  return name.replace(/\\/g, '/');
}

async function loadFiles() {
  const entries = await fs.readdir(imagesDir, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && /^10그룹-.*\.(jpg|jpeg|png|webp)$/i.test(entry.name))
    .map(entry => ({
      fileName: entry.name,
      relativePath: normalizeFileName(path.join('public', 'images', entry.name)),
      absolutePath: path.join(imagesDir, entry.name)
    }))
    .sort((a, b) => a.fileName.localeCompare(b.fileName, 'ko'));
}

async function readImageAsDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  const buffer = await fs.readFile(filePath);
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function analyzeOne(file) {
  if (!apiKey) {
    return {
      status: 'pending',
      fileName: file.fileName,
      relativePath: file.relativePath,
      petType: 'unknown',
      petCount: null,
      petCountConfidence: 0,
      breed: null,
      breedConfidence: 0,
      evidence: [],
      warnings: ['OPENAI_API_KEY is missing; analysis has not been run yet.']
    };
  }

  const image = await readImageAsDataUrl(file.absolutePath);
  const prompt = `You are ScanFit's conservative breed and multi-pet image analyst.
Analyze this pet image for the highest-accuracy dataset.
Rules:
- Do not guess a breed unless it is visibly supportable.
- If multiple pets are visible, count them conservatively.
- If the breed is uncertain, return null and say so.
- Separate visible evidence from inference.
- If the image is low quality or cropped, lower confidence instead of inventing values.
Return only valid JSON with:
{
  "petType":"dog|cat|mixed|unknown",
  "petCount": number,
  "petCountConfidence": number from 0 to 1,
  "breed": "best supported breed name or null",
  "breedConfidence": number from 0 to 1,
  "notes": "brief conservative note",
  "evidence": [
    {"label":"visible cue", "value":"what is visible", "reason":"why it matters"}
  ],
  "warnings": ["warning 1", "warning 2"]
}
If multiple animals are present, include that note. If nothing is certain, use null and low confidence.`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          { type: 'input_image', image_url: image }
        ]
      }]
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    return {
      status: 'error',
      fileName: file.fileName,
      relativePath: file.relativePath,
      error: raw
    };
  }

  const data = JSON.parse(raw);
  const text = data.output_text || data.output?.flatMap(item => item.content || []).map(item => item.text || '').join('\n') || '';
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const parsed = JSON.parse(cleaned.slice(start, end + 1));

  return {
    status: 'analyzed',
    fileName: file.fileName,
    relativePath: file.relativePath,
    petType: parsed.petType || 'unknown',
    petCount: Number(parsed.petCount || 1),
    petCountConfidence: Number(parsed.petCountConfidence || 0),
    breed: parsed.breed || null,
    breedConfidence: Number(parsed.breedConfidence || 0),
    notes: parsed.notes || '',
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : []
  };
}

async function main() {
  const files = await loadFiles();
  await fs.mkdir(outDir, { recursive: true });

  const results = [];
  for (const file of files) {
    process.stdout.write(`Analyzing ${file.fileName}...\n`);
    results.push(await analyzeOne(file));
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    model: apiKey ? model : null,
    source: 'public/images/10그룹-*',
    count: results.length,
    results
  };

  await fs.writeFile(outFile, JSON.stringify(payload, null, 2), 'utf8');
  process.stdout.write(`Saved ${results.length} records to ${outFile}\n`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
