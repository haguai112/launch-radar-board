// Launch Radar entry point (Node 22, standard library only).
//
// Reads the sealed snapshot (/input/snapshot.json in the grader, or
// --input <file|dir> locally), scores every pre-token protocol with the
// model in lib/model.ts, and writes the hand-in to /output:
//   board.json    the ranked board the gate reads
//   data.js       the same board, for the static dashboard
//   dashboard/    a copy of this repository's dashboard/
//   screenshots/  a copy of this repository's screenshots/
//   dossier.json  buildDossier's summary, written last, byte-compared
//                 by the scorer against its own rebuild
// Local run: mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildBoard, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TEXT_MAX_BYTES = 65_536;

function argument(name: string, fallback: string): string {
  const flag = `--${name}`;
  const at = process.argv.indexOf(flag);
  if (at !== -1 && process.argv[at + 1] !== undefined) return process.argv[at + 1]!;
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline === undefined ? fallback : inline.slice(flag.length + 1);
}

function copyTree(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const source = join(from, name);
    if (!statSync(source).isFile()) continue;
    copyFileSync(source, join(to, name));
    copied.push(name);
  }
  return copied;
}

const inputArg = argument('input', '/input');
const inputPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputPath)) {
  process.stderr.write(`launch radar: no snapshot at ${inputPath}\n`);
  process.exit(2);
}
const outputDir = argument('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputPath, 'utf8'));
const rows = buildBoard(snapshot);
const issue = boardIssue(rows, snapshot);
if (issue !== null) {
  process.stderr.write(`launch radar: refusing to hand in a board the gate rejects: ${issue}\n`);
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'board.json'), `${JSON.stringify({ rows })}\n`);
writeFileSync(join(outputDir, 'data.js'), dataScript(snapshot, rows));
const pageFiles = copyTree(join(ROOT, 'dashboard'), join(outputDir, 'dashboard'));
const shots = copyTree(join(ROOT, 'screenshots'), join(outputDir, 'screenshots'));
if (shots.length < 3 || shots.length > 4) {
  process.stderr.write(`launch radar: screenshots/ holds ${shots.length} images; the gate wants 3 to 4\n`);
  process.exit(1);
}

writeFileSync(
  join(outputDir, 'dossier.json'),
  buildDossier(outputDir, {
    text_max_bytes: TEXT_MAX_BYTES,
    screenshots: { max: 4, max_bytes: 524_288 },
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  }),
);

process.stdout.write(
  `launch radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} watchlist, ${rows.length} rows boarded\n` +
    `launch radar: wrote board.json, data.js, dashboard/ (${pageFiles.length} files), screenshots/ (${shots.length}) and dossier.json to ${outputDir}\n`,
);
