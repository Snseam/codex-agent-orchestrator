#!/usr/bin/env node
import fs from 'node:fs/promises';
import { evaluateBenchmark } from './evaluator.mjs';

function usage() {
  return 'Usage: node benchmarks/evaluate.mjs <plan.json> <results.json>';
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function main(argv) {
  if (argv.length !== 2 || argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return argv.length === 0 || argv.includes('--help') || argv.includes('-h') ? 0 : 2;
  }
  const [planFile, resultsFile] = argv;
  const report = evaluateBenchmark(await readJson(planFile), await readJson(resultsFile));
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

main(process.argv.slice(2)).then(
  code => { process.exitCode = code; },
  error => {
    console.error(JSON.stringify({ error: { code: error.code ?? 'benchmark_evaluation_failed', message: error.message } }));
    process.exitCode = 1;
  },
);
