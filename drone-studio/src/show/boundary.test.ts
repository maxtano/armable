import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Armable is two products in one codebase: the drone bench (src/web, index.html) and Armable Shows
 * (src/show, show.html). They share the account, the device layer and the design system, and nothing of their
 * interfaces. These tests are the boundary: they fail if one surface starts reaching into the other.
 */
const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const sources = (dir: string): string[] =>
  readdirSync(new URL(`${dir}/`, root), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? sources(`${dir}/${entry.name}`) : /\.tsx?$/.test(entry.name) ? [`${dir}/${entry.name}`] : []);
const importsOf = (path: string) => [...read(path).matchAll(/from\s+'([^']+)'|import\('([^']+)'\)|new URL\('([^']+)'/g)]
  .map(m => m[1] ?? m[2] ?? m[3]);
/** Where an import inside `file` lands, as a path under src/. */
const target = (file: string, spec: string) => {
  if (!spec.startsWith('.')) return undefined;
  const parts = [...file.split('/').slice(0, -1), ...spec.split('/')];
  const out: string[] = [];
  for (const part of parts) { if (part === '.') continue; if (part === '..') out.pop(); else out.push(part); }
  return out.join('/');
};
const area = (path: string | undefined) => path?.split('/')[1];

describe('the bench and Armable Shows are separate surfaces', () => {
  const SHOW_ONLY = ['show', 'core', 'components', 'audio', 'agent'];

  it('gives each product its own entry point', () => {
    expect(read('../index.html')).toContain('/src/web/main.tsx');
    expect(read('../index.html')).not.toContain('/src/show/');
    expect(read('../show.html')).toContain('/src/show/main.tsx');
    expect(read('../show.html')).not.toContain('/src/web/');
  });

  it('keeps the show engine out of the configuration workspace', () => {
    const offenders = sources('web').flatMap(file =>
      importsOf(file).filter(spec => SHOW_ONLY.includes(area(target(file, spec)) ?? '')).map(spec => `${file} -> ${spec}`));
    expect(offenders).toEqual([]);
  });

  it('keeps the configuration workspace out of the show engine', () => {
    const offenders = SHOW_ONLY.flatMap(dir => sources(dir)).flatMap(file =>
      importsOf(file).filter(spec => area(target(file, spec)) === 'web').map(spec => `${file} -> ${spec}`));
    expect(offenders).toEqual([]);
  });

  it('shows the configuration workspace no choreography', () => {
    // Comments may name the other product; the interface may not.
    const shell = read('web/App.tsx').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const word of ['storyboard', 'formation', 'keyframe', 'choreograph', 'audience']) expect(shell.toLowerCase()).not.toContain(word);
    // The one way across is a link to the other product, not a section of this one.
    expect(shell).toContain('href="/show"');
    expect(read('web/store.ts')).not.toMatch(/View =.*'show'/);
  });

  it('shares the account, the device layer and the design system rather than copying them', () => {
    for (const file of ['show/App.tsx', 'show/library.tsx']) expect(read(file)).toContain("from '../platform/cloud'");
    expect(read('web/controller.ts')).toContain("from '../platform/cloud'");
    expect(sources('platform').concat(sources('device'), sources('design-system')).flatMap(file =>
      importsOf(file).filter(spec => ['web', ...SHOW_ONLY].includes(area(target(file, spec)) ?? '')).map(spec => `${file} -> ${spec}`))).toEqual([]);
  });
});
