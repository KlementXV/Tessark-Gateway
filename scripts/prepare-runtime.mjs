// Add the migration/seed dependency closure to Next's traced output without shipping
// the build toolchain. Resolve the packages actually installed by npm ci: the lockfile
// remains the single source of versions, including nested overrides and native binaries.
import { cp, mkdir, readFile, realpath, stat, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

const source = resolve(process.argv[2] ?? '.');
const output = resolve(process.argv[3] ?? '.next/standalone');
if (source === output) throw new Error('Runtime output must differ from the source directory');
const copied = new Set();

async function locate(name, parent) {
  const require = createRequire(join(parent, 'package.json'));
  for (const search of require.resolve.paths(name) ?? []) {
    const candidate = join(search, name);
    try { await stat(join(candidate, 'package.json')); return candidate; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return null;
}

async function copyPackage(name, parent, optional = false) {
  const installed = await locate(name, parent);
  if (!installed) {
    if (optional) return;
    throw new Error(`Missing runtime dependency ${name} required by ${parent}`);
  }
  const packagePath = await realpath(installed);
  const path = relative(source, packagePath);
  if (path.startsWith('..') || !path.startsWith('node_modules/')) {
    throw new Error(`Dependency ${name} resolved outside the installed dependency tree`);
  }
  if (copied.has(packagePath)) return;
  copied.add(packagePath);
  const metadata = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'));
  const destination = join(output, path);
  await mkdir(dirname(destination), { recursive: true });
  await cp(packagePath, destination, {
    recursive: true,
    // Nested packages are handled through their actual dependency edges below.
    filter: entry => entry !== join(packagePath, 'node_modules'),
  });
  const optionalDependencies = metadata.optionalDependencies ?? {};
  for (const dependency of Object.keys(metadata.dependencies ?? {})) {
    await copyPackage(dependency, packagePath, dependency in optionalDependencies);
  }
  for (const dependency of Object.keys(optionalDependencies)) await copyPackage(dependency, packagePath, true);
  for (const dependency of Object.keys(metadata.peerDependencies ?? {})) {
    if (!metadata.peerDependenciesMeta?.[dependency]?.optional) await copyPackage(dependency, packagePath);
  }
  const bins = typeof metadata.bin === 'string'
    ? { [metadata.name.split('/').pop()]: metadata.bin } : metadata.bin ?? {};
  const modules = metadata.name.startsWith('@') ? dirname(dirname(destination)) : dirname(destination);
  await mkdir(join(modules, '.bin'), { recursive: true });
  for (const [name, target] of Object.entries(bins)) {
    const link = join(modules, '.bin', name);
    try { await symlink(relative(dirname(link), join(destination, target)), link); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

for (const dependency of ['prisma', 'tsx', 'dotenv', 'zod']) await copyPackage(dependency, source);
// tsx needs the source imports and tsconfig aliases used by prisma/seed.ts. The generated
// client and native query engine must remain at the paths resolved during prisma generate.
for (const path of ['prisma', 'prisma.config.ts', 'tsconfig.json', 'src/lib', 'src/generated/prisma']) {
  await cp(join(source, path), join(output, path), { recursive: true });
}
console.log(`Runtime prepared with ${copied.size} migration/seed packages; build dependencies excluded.`);
