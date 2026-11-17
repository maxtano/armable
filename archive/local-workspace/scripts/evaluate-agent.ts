import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  createEvaluationFixtureProvider,
  listEvaluationCases,
  runEvaluationSuite,
} from '../src/agent/evaluation';

const help = `Lucidity agent evaluations · synthetic projects only

Usage: npm run --silent agent:eval -- [options]

  --list                  List case IDs, titles, and prompts as JSON
  --mode fixture          Scripted tool-loop checks (the only mode)
  --case ID               Select a case (repeat for several)
  --all                   Select every case
  --out PATH              Save a JSON report; refuses an existing file
  --help                  Show this help

All cases run unless --case is supplied. No model is called: Lucidity no longer
contains a model provider. Assistants reach it over MCP instead. Runs are serial.

Reports contain exact proposed operations, checks, tool events, usage, and
latency. They contain no API key or raw model continuation. No case changes
a saved show. Passes describe semantic checks, not flight qualification or
subjective artistic quality. Ctrl+C cancels the active run.

Exit codes: 0 passed/list/help, 1 failed checks, 2 configuration error,
130 cancelled. JSON reports go to stdout unless --out is supplied; progress
goes to stderr. Use --silent to keep npm banners out of JSON output.`;

let output: Awaited<ReturnType<typeof open>> | undefined;
try {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean' },
      list: { type: 'boolean' },
      mode: { type: 'string', default: 'fixture' },
      case: { type: 'string', multiple: true },
      all: { type: 'boolean' },
      model: { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(help);
  } else if (values.list) {
    console.log(JSON.stringify(listEvaluationCases(), null, 2));
  } else {
    if (values.mode !== 'fixture' && values.mode !== 'live')
      throw new Error('--mode must be fixture or live.');
    if (values.all && values.case?.length) throw new Error('Choose --all or --case, not both.');
    const available = new Set(listEvaluationCases().map((test) => test.id));
    const caseIds = values.case ? [...new Set(values.case)] : undefined;
    if (caseIds?.some((id) => !available.has(id)))
      throw new Error('Unknown case ID. Use --list to see available cases.');
    if (values.mode === 'live' && !values.all && !caseIds?.length)
      throw new Error('Live mode requires --case ID or an explicit --all.');

    const model: string | null = null;
    // Lucidity no longer calls a model provider. Assistants reach it over MCP; see docs/TOOL_APP_ARCHITECTURE.md.
    if (values.mode === 'live') throw new Error('Live mode was removed with the model-provider adapter. Connect an assistant over MCP instead.');
    const path = values.out ? resolve(values.out) : null;
    if (path) {
      await mkdir(dirname(path), { recursive: true });
      output = await open(path, 'wx');
    }
    const controller = new AbortController();
    const cancel = () => controller.abort('cancelled');
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      console.error(
        values.mode === 'fixture'
          ? 'Scripted fixture evaluation: no model calls; no model-quality claim.'
          : `Live model evaluation: ${model}; synthetic projects only.`
      );
      const report = await runEvaluationSuite({
        caseIds,
        signal: controller.signal,
        providerFactory: (request, caseId) =>
          createEvaluationFixtureProvider(request, caseId),
        onCase: (result) =>
          console.error(`${result.status.toUpperCase()} ${result.id} · ${result.durationMs} ms`),
      });
      const document = JSON.stringify(
        {
          ...report,
          mode: values.mode,
          provider: 'scripted-fixture',
          model,
          qualification: 'Scripted tool-loop and evaluator checks; does not measure model capability.',
        },
        null,
        2
      );
      const safeDocument = document;
      if (output) {
        await output.writeFile(`${safeDocument}\n`, 'utf8');
        console.error(`Report saved: ${path}`);
      } else console.log(safeDocument);
      process.exitCode = report.status === 'cancelled' ? 130 : report.status === 'passed' ? 0 : 1;
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
  }
} catch (cause) {
  const message = cause instanceof Error ? cause.message : 'Evaluation could not start.';
  console.error(
    JSON.stringify({ error: message })
  );
  process.exitCode = 2;
} finally {
  await output?.close();
}
